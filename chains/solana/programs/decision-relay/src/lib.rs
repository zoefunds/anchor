//! decision-relay: the Solana-side counterpart to
//! chains/evm/contracts/DecisionRelay.sol. Native Solana program (not
//! Anchor) because Hyperlane's own Sealevel libraries are native — see
//! chains/solana/README.md for why.
//!
//! Two directions:
//!   - dispatch_case_originate: raises a dispute on Solana, sends a
//!     CASE_ORIGINATE message to Anchor's EVM domain via the Hyperlane
//!     Mailbox (CPI into OutboxDispatch, same pattern as Hyperlane's own
//!     reference `test-send-receiver` program).
//!   - handle: receives a DECISION_RELAY message from EVM once GenLayer's
//!     adjudication finalizes, then CPIs into escrow's `settle` instruction
//!     to actually move funds.
//!
//! Verified against real, fetched source (not memory):
//!   - rust/sealevel/programs/test-send-receiver/src/program.rs — the
//!     dispatch/handle CPI pattern, PDA derivation.
//!   - rust/sealevel/libraries/message-recipient-interface/src/lib.rs —
//!     MessageRecipientInstruction encoding/discriminators.
//!   - rust/sealevel/programs/mailbox/src/{instruction,pda_seeds}.rs —
//!     OutboxDispatch shape, all PDA seed macros.
//! All in github.com/hyperlane-xyz/hyperlane-monorepo, pinned at
//! rev b58c7eb7275cd61467805f8841d26682118b6f1b (see Cargo.toml).
//!
//! escrow's `settle` discriminator ([175, 42, 185, 87, 144, 131, 102, 212])
//! is read directly from target/idl/escrow.json, not recomputed by hand.

use account_utils::{create_pda_account, AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_mailbox::{
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_message_dispatch_authority_pda_seeds, mailbox_process_authority_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;
use solana_instructions_sysvar::get_instruction_relative;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

const SETTLE_DISCRIMINATOR: [u8; 8] = [175, 42, 185, 87, 144, 131, 102, 212];

/// A deployed hyperlane-sealevel-composite-ism instance, initialized with
/// root node `IsmNode::TrustedRelayer { relayer: <our relayer's Solana
/// signer pubkey> }` — see chains/solana/tests/init-composite-ism.ts. Its
/// Verify instruction accepts iff our own relayer key signed the inbound
/// process() call, same tradeoff as chains/evm/contracts/TrustedRelayerIsm.sol
/// on the EVM side: sound only because Anchor is both the sole dispatcher
/// and sole relayer for this route. Replaces the Mailbox's default (a
/// multisig ISM requiring a validator checkpoint Anchor doesn't publish —
/// see chains/hyperlane-relayer/README.md's "Known issue NOT fixed").
const TRUSTED_ISM: Pubkey = solana_program::pubkey!("PNMVXEfSvLYhF917ViQTSTf4MVmVjXs7zrVBNe2mfus");

/// M-of-N: Anchor's dedicated Solana attestation keys (Ed25519, distinct
/// from this program's upgrade authority and from the Hyperlane
/// relayer's own signer) — see `attested_settle`'s doc comment for the
/// full trust model this closes. Their EVM counterpart is
/// DecisionRelay.sol's `isAttestor`/`attestorThreshold` (different keys —
/// secp256k1, EVM-native — since Solana verifies Ed25519 natively via a
/// native program while EVM verifies secp256k1 via ecrecover; there is
/// no single key usable on both).
///
/// No on-chain governance/owner account for this set — unlike
/// DecisionRelay.sol's Safe-owned `isAttestor` mapping, this program has
/// no upgradeable state for it, only these consts. Rotating a key means
/// changing this array and redeploying (which this program's own
/// upgrade authority can do) — see docs/multisig-attestor-setup.md's
/// Solana section for the operational tradeoff that implies.
const ATTESTOR_PUBKEYS: [Pubkey; 2] = [
    // Backend-held (SOLANA_ATTESTOR_PRIVATE_KEY on anc-hor-worker) — the
    // pre-existing single key, kept as one of two rather than dropped.
    solana_program::pubkey!("4EnM9nxVcWoaRRsEZnq2otdVrQLiwdBsBkqxdmRoVBCq"),
    // Held entirely offline — generated via `solana-keygen new` on a
    // machine never connected to Fly/Vercel, mirroring the EVM side's
    // real 2-of-2 split (see docs/multisig-attestor-setup.md). The
    // backend never had this private key.
    solana_program::pubkey!("7RcEJvhzeHzaZ3CDn5SEe9BEcYLxP1C2KawuCMqof1zY"),
];
const ATTESTOR_THRESHOLD: usize = 2;

#[macro_export]
macro_rules! decision_relay_storage_pda_seeds {
    () => {{
        &[b"decision_relay", b"-", b"storage"]
    }};
    ($bump_seed:expr) => {{
        &[b"decision_relay", b"-", b"storage", &[$bump_seed]]
    }};
}

/// The PDA that acts as `adjudicator` on escrow cases settled via this
/// program — only this program can produce a valid signature for it
/// (via invoke_signed), so only a real relayed Hyperlane message can ever
/// reach escrow.settle() for cases configured with this authority.
#[macro_export]
macro_rules! decision_relay_escrow_authority_pda_seeds {
    () => {{
        &[b"decision_relay", b"-", b"escrow_authority"]
    }};
    ($bump_seed:expr) => {{
        &[b"decision_relay", b"-", b"escrow_authority", &[$bump_seed]]
    }};
}

pub type DecisionRelayStorageAccount = AccountData<DecisionRelayStorage>;

#[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
pub struct DecisionRelayStorage {
    pub mailbox: Pubkey,
    pub escrow_program: Pubkey,
}

impl SizedData for DecisionRelayStorage {
    fn size(&self) -> usize {
        32 + 32
    }
}

/// The DECISION_RELAY message body, borsh-encoded, dispatched from EVM.
/// Carries claimant/respondent directly (not just case_id) because
/// Hyperlane's HandleAccountMetas query can only decode the message
/// itself, not read arbitrary on-chain state — see module docs.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct DecisionRelayBody {
    pub case_id: String,
    pub claimant: Pubkey,
    pub respondent: Pubkey,
    /// Included so `handle_account_metas` can derive the case PDA without
    /// reading on-chain state — that call only ever receives one fixed
    /// PDA per Hyperlane's interface, not our storage account. Checked
    /// against storage.escrow_program in `handle` as a consistency guard.
    pub escrow_program: Pubkey,
    pub claimant_share_bps: u16,
    pub respondent_share_bps: u16,
    /// sha256 fingerprint of the full decision (case/policy ids, outcome,
    /// shares, reason codes, proofHash, contractCodeHash — see
    /// adjudication-service.ts's computeDecisionHash on the Anchor
    /// backend). The same value carried as EVM DecisionRelay.sol's
    /// proofHash, so this side can bind settlement to the exact decision
    /// Anchor claims to have made, not just the shares it derived from
    /// it. Not used to gate a PDA-based idempotency check (see `handle`'s
    /// doc comment for why) — destination-side idempotency here comes
    /// from escrow's own `case.status` guard instead. Kept in the wire
    /// format for audit/record purposes and parity with the EVM side.
    pub decision_hash: [u8; 32],
}

/// The CASE_ORIGINATE message body this program dispatches outbound.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct CaseOriginateBody {
    pub case_id: String,
    pub claimant: Pubkey,
    pub respondent: Pubkey,
    pub amount_lamports: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum DecisionRelayInstruction {
    Init { mailbox: Pubkey, escrow_program: Pubkey },
    DispatchCaseOriginate(OutboxDispatch),
    /// Submitted directly by Anchor's backend (not via Hyperlane) — see
    /// `attested_settle`'s doc comment for why this, not `handle`, is
    /// the only path that actually moves funds.
    AttestedSettle(DecisionRelayBody),
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if let Ok(recipient_instruction) = MessageRecipientInstruction::decode(instruction_data) {
        return match recipient_instruction {
            MessageRecipientInstruction::InterchainSecurityModule => {
                // Returning Some(TRUSTED_ISM) here (rather than None, which
                // means "use the Mailbox's default") is what makes
                // TRUSTED_ISM's TrustedRelayer check the actual gate for
                // inbound messages, instead of the default multisig ISM
                // that needs a validator checkpoint we don't publish. Must
                // be an explicitly Borsh-encoded Option::<Pubkey> via
                // set_return_data - a bare Ok(()) with no return data at
                // all is NOT the same thing and errors out relayer-side
                // ("No return data from InboxGetRecipientIsm instruction"),
                // confirmed against real Sepolia->Solana Testnet delivery
                // attempts and the reference implementation in Hyperlane's
                // own test-send-receiver program (programs/test-send-receiver/
                // src/program.rs's get_interchain_security_module, pinned
                // at the same rev as everything else in this file).
                let ism: Option<Pubkey> = Some(TRUSTED_ISM);
                solana_program::program::set_return_data(
                    &borsh::to_vec(&ism).map_err(|_| ProgramError::BorshIoError)?,
                );
                Ok(())
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => Ok(()),
            MessageRecipientInstruction::Handle(handle_ix) => handle(program_id, accounts, handle_ix),
            MessageRecipientInstruction::HandleAccountMetas(handle_ix) => {
                handle_account_metas(program_id, handle_ix)
            }
        };
    }

    let instruction = DecisionRelayInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    match instruction {
        DecisionRelayInstruction::Init { mailbox, escrow_program } => {
            init(program_id, accounts, mailbox, escrow_program)
        }
        DecisionRelayInstruction::DispatchCaseOriginate(outbox_dispatch) => {
            dispatch(program_id, accounts, outbox_dispatch)
        }
        DecisionRelayInstruction::AttestedSettle(body) => attested_settle(program_id, accounts, body),
    }
}

/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[signer]` Payer.
/// 2. `[writeable]` Storage PDA.
fn init(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    mailbox: Pubkey,
    escrow_program: Pubkey,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let storage_info = next_account_info(accounts_iter)?;
    let (storage_pda_key, storage_bump) =
        Pubkey::find_program_address(decision_relay_storage_pda_seeds!(), program_id);
    if storage_info.key != &storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }

    let storage_account = DecisionRelayStorageAccount::from(DecisionRelayStorage {
        mailbox,
        escrow_program,
    });
    create_pda_account(
        payer_info,
        &Rent::get()?,
        storage_account.size(),
        program_id,
        system_program_info,
        storage_info,
        decision_relay_storage_pda_seeds!(storage_bump),
    )?;
    storage_account.store(storage_info, false)?;

    Ok(())
}

/// Dispatches a message via the Mailbox's OutboxDispatch instruction.
/// Same account layout as Hyperlane's own test-send-receiver::dispatch —
/// see that source for the authoritative account ordering.
///
/// Accounts:
/// 0. `[executable]` Mailbox program.
/// 1. `[writeable]` Outbox PDA.
/// 2. `[]` This program's dispatch authority.
/// 3. `[executable]` System program.
/// 4. `[executable]` SPL Noop program.
/// 5. `[signer]` Payer.
/// 6. `[signer]` Unique message account.
/// 7. `[writeable]` Dispatched message PDA.
fn dispatch(program_id: &Pubkey, accounts: &[AccountInfo], outbox_dispatch: OutboxDispatch) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let mailbox_info = next_account_info(accounts_iter)?;
    let mailbox_outbox_info = next_account_info(accounts_iter)?;
    let dispatch_authority_info = next_account_info(accounts_iter)?;
    let (expected_dispatch_authority_key, expected_dispatch_authority_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);
    if dispatch_authority_info.key != &expected_dispatch_authority_key {
        return Err(ProgramError::InvalidArgument);
    }
    let system_program_info = next_account_info(accounts_iter)?;
    let spl_noop_info = next_account_info(accounts_iter)?;
    let payer_info = next_account_info(accounts_iter)?;
    let unique_message_account_info = next_account_info(accounts_iter)?;
    let dispatched_message_info = next_account_info(accounts_iter)?;

    let instruction = Instruction {
        program_id: *mailbox_info.key,
        data: MailboxInstruction::OutboxDispatch(outbox_dispatch).into_instruction_data()?,
        accounts: vec![
            AccountMeta::new(*mailbox_outbox_info.key, false),
            AccountMeta::new_readonly(*dispatch_authority_info.key, true),
            AccountMeta::new_readonly(*system_program_info.key, false),
            AccountMeta::new_readonly(*spl_noop_info.key, false),
            AccountMeta::new(*payer_info.key, true),
            AccountMeta::new_readonly(*unique_message_account_info.key, true),
            AccountMeta::new(*dispatched_message_info.key, false),
        ],
    };
    invoke_signed(
        &instruction,
        &[
            mailbox_outbox_info.clone(),
            dispatch_authority_info.clone(),
            system_program_info.clone(),
            spl_noop_info.clone(),
            payer_info.clone(),
            unique_message_account_info.clone(),
            dispatched_message_info.clone(),
        ],
        &[mailbox_message_dispatch_authority_pda_seeds!(
            expected_dispatch_authority_bump
        )],
    )
}

/// Handles an inbound DECISION_RELAY message from Hyperlane. NOTIFICATION
/// ONLY — this no longer CPIs into escrow's `settle` or moves any funds.
///
/// Why: this path's only real gate was `TRUSTED_ISM`-equivalent trust in
/// the Sealevel relayer/ISM combination (`verify()` always accepts, same
/// posture as TrustedRelayerIsm.sol on the EVM side) — nothing here
/// cryptographically bound the SETTLEMENT DECISION to a real Anchor
/// attestation the way EVM's DecisionRelay.sol now does via `ecrecover`.
/// A compromised relay/dispatch pipeline could get any settlement
/// accepted. Solana's own equivalent of `ecrecover` — Ed25519 signature
/// verification — needs a SEPARATE instruction in the same transaction
/// (the `Ed25519SigVerify111...` native program), and this program has
/// no control over how the Hyperlane relayer binary builds its own
/// `process()` transaction, so an attestation check can't be added to
/// this Hyperlane-triggered path at all. `attested_settle` below is the
/// real fix: a transaction Anchor's own backend builds directly (not via
/// Hyperlane), which CAN include the Ed25519 verify instruction.
/// Hyperlane's message still arrives and is validated here (a real
/// record of "GenLayer's side dispatched this decision"), it just no
/// longer authorizes moving funds by itself.
///
/// Accounts:
/// 0. `[]` Process authority specific to this program (signer).
/// 1. `[]` Storage PDA account.
/// 2. `[executable]` Escrow program (consistency-checked against storage).
pub fn handle(program_id: &Pubkey, accounts: &[AccountInfo], handle_ix: HandleInstruction) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let process_authority = next_account_info(accounts_iter)?;
    let storage_info = next_account_info(accounts_iter)?;
    let storage = DecisionRelayStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    let (expected_process_authority_key, _bump) =
        Pubkey::find_program_address(mailbox_process_authority_pda_seeds!(program_id), &storage.mailbox);
    if process_authority.key != &expected_process_authority_key {
        return Err(ProgramError::InvalidArgument);
    }
    if !process_authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let escrow_program_info = next_account_info(accounts_iter)?;
    if escrow_program_info.key != &storage.escrow_program {
        return Err(ProgramError::InvalidArgument);
    }

    let body = DecisionRelayBody::try_from_slice(&handle_ix.message)
        .map_err(|_| ProgramError::BorshIoError)?;
    if body.escrow_program != storage.escrow_program {
        return Err(ProgramError::InvalidArgument);
    }

    msg!(
        "decision-relay: notified of decision for case {} (no settlement dispatched from this path — see attested_settle)",
        body.case_id
    );
    Ok(())
}

/// The actual fund-moving path — see `handle`'s doc comment for why
/// Hyperlane delivery alone no longer triggers settlement. Submitted by
/// Anchor's own backend (holding a funded Solana signer already used
/// elsewhere in this program, e.g. dispatch's payer) as a normal
/// transaction it constructs itself, with `ATTESTOR_PUBKEYS.len()` real
/// Ed25519 signature verification instructions (the
/// `Ed25519SigVerify111...` native program), one per co-signing
/// attestor, placed immediately before this one — M-of-N, see
/// `verify_decision_attestations`.
///
/// Verification here means: read the `ATTESTOR_PUBKEYS.len()`
/// instructions immediately preceding this one via the instructions
/// sysvar, confirm each is really the Ed25519 native program
/// (introspection reads the ACTUAL instruction the runtime is
/// executing, this can't be spoofed), parse its data using the real,
/// source-confirmed `solana-ed25519-program` wire format (num_signatures
/// byte, then a fixed-size `Ed25519SignatureOffsets` struct, then
/// pubkey/signature/message bytes at the offsets that struct
/// specifies), and require at least `ATTESTOR_THRESHOLD` of them embed a
/// pubkey from ATTESTOR_PUBKEYS (each counted at most once — see the
/// dedup note there) and a message equal to EXACTLY the bytes this
/// function independently recomputes from `body` — never the message
/// bytes as merely claimed by the instruction, always recomputed and
/// compared. The signatures themselves aren't re-verified here: the
/// Solana runtime already did that as part of processing each Ed25519
/// instruction earlier in this same transaction, and if any were
/// invalid the whole transaction would have failed atomically before
/// this instruction ever ran.
///
/// Idempotency: no processed-decision PDA (same reasoning as the old
/// `handle` — see git history) — escrow's own `case.status`/
/// `AlreadySettled` guard is the backstop, so a second AttestedSettle
/// for an already-settled case reverts there, cleanly, regardless of
/// how many times Anchor's backend (mistakenly or not) submits it.
///
/// Accounts:
/// 0. `[]` Instructions sysvar (`Sysvar1nstructions1111111111111111111111111`).
/// 1. `[]` Storage PDA account.
/// 2. `[executable]` Escrow program.
/// 3. `[writeable]` Case PDA (escrow's `["case", case_id]`).
/// 4. `[writeable]` Claimant account (from the message body).
/// 5. `[writeable]` Respondent account (from the message body).
/// 6. `[]` This program's escrow-authority PDA.
fn attested_settle(program_id: &Pubkey, accounts: &[AccountInfo], body: DecisionRelayBody) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let instructions_sysvar_info = next_account_info(accounts_iter)?;
    let storage_info = next_account_info(accounts_iter)?;
    let storage = DecisionRelayStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    let escrow_program_info = next_account_info(accounts_iter)?;
    if escrow_program_info.key != &storage.escrow_program {
        return Err(ProgramError::InvalidArgument);
    }
    if body.escrow_program != storage.escrow_program {
        return Err(ProgramError::InvalidArgument);
    }
    let case_info = next_account_info(accounts_iter)?;
    let claimant_info = next_account_info(accounts_iter)?;
    let respondent_info = next_account_info(accounts_iter)?;
    let escrow_authority_info = next_account_info(accounts_iter)?;

    if claimant_info.key != &body.claimant || respondent_info.key != &body.respondent {
        return Err(ProgramError::InvalidArgument);
    }

    let (expected_case_key, _case_bump) =
        Pubkey::find_program_address(&[b"case", body.case_id.as_bytes()], escrow_program_info.key);
    if case_info.key != &expected_case_key {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_escrow_authority_key, escrow_authority_bump) =
        Pubkey::find_program_address(decision_relay_escrow_authority_pda_seeds!(), program_id);
    if escrow_authority_info.key != &expected_escrow_authority_key {
        return Err(ProgramError::InvalidArgument);
    }

    verify_decision_attestations(program_id, instructions_sysvar_info, &body)?;

    let mut settle_data = SETTLE_DISCRIMINATOR.to_vec();
    settle_data.extend_from_slice(&body.claimant_share_bps.to_le_bytes());
    settle_data.extend_from_slice(&body.respondent_share_bps.to_le_bytes());

    let settle_ix = Instruction {
        program_id: *escrow_program_info.key,
        data: settle_data,
        accounts: vec![
            AccountMeta::new_readonly(*escrow_authority_info.key, true),
            AccountMeta::new(*case_info.key, false),
            AccountMeta::new(*claimant_info.key, false),
            AccountMeta::new(*respondent_info.key, false),
        ],
    };

    invoke_signed(
        &settle_ix,
        &[
            escrow_authority_info.clone(),
            case_info.clone(),
            claimant_info.clone(),
            respondent_info.clone(),
        ],
        &[decision_relay_escrow_authority_pda_seeds!(escrow_authority_bump)],
    )?;

    msg!("decision-relay: attested-settled case {}", body.case_id);
    Ok(())
}

/// The exact bytes Anchor's backend signs with ATTESTOR_PUBKEY's private
/// key (see apps/web/src/lib/solana-attestation.ts) — a domain tag (so a
/// signature can't be replayed as if it meant something else entirely),
/// then every field of the decision that actually matters for
/// settlement. No program-id binding beyond the tag is included because
/// this key is Solana-specific already — there is exactly one
/// decision-relay program this key is ever meant to attest for (unlike
/// the EVM attestor's hash, which binds `address(this)` to distinguish
/// between possible EVM deployments of the same contract code).
fn decision_attestation_message(program_id: &Pubkey, body: &DecisionRelayBody) -> Vec<u8> {
    let mut message = b"ANCHOR_SOLANA_DECISION_ATTESTATION_V2".to_vec();
    // Cluster binding (defense in depth, per re-audit) — Solana Testnet's
    // real genesis hash, confirmed live via `getGenesisHash` RPC, not
    // guessed. A program can't query its own cluster's genesis hash at
    // runtime (no sysvar exposes it to instruction execution), so this
    // is a compile-time tag: if this exact program were ever deployed to
    // a different cluster, attestations minted for THIS build (tagged
    // testnet) would carry a mismatched tag there too, adding a second,
    // independent check beyond program_id below rather than a live
    // runtime verification that "we are actually on testnet" — real
    // value as defense in depth, not the sole boundary on its own.
    const TESTNET_GENESIS_HASH: Pubkey = solana_program::pubkey!("4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY");
    message.extend_from_slice(TESTNET_GENESIS_HASH.as_ref());
    // Program binding (real, on-chain-verifiable — program_id is the
    // actual parameter this instruction executed with) — prevents a
    // signature minted for one decision-relay deployment being replayed
    // against a different one, same reasoning as EVM's `address(this)`
    // binding in DecisionRelay.sol.
    message.extend_from_slice(program_id.as_ref());
    let case_id_bytes = body.case_id.as_bytes();
    message.extend_from_slice(&(case_id_bytes.len() as u32).to_le_bytes());
    message.extend_from_slice(case_id_bytes);
    message.extend_from_slice(body.claimant.as_ref());
    message.extend_from_slice(body.respondent.as_ref());
    message.extend_from_slice(body.escrow_program.as_ref());
    message.extend_from_slice(&body.claimant_share_bps.to_le_bytes());
    message.extend_from_slice(&body.respondent_share_bps.to_le_bytes());
    message.extend_from_slice(&body.decision_hash);
    message
}

/// Parses a real Ed25519 native-program instruction's data (format
/// confirmed directly from the `solana-ed25519-program` crate source,
/// not assumed) and, if it's a well-formed, non-redirected, genuinely
/// runtime-verified Ed25519 instruction over exactly `expected_message`,
/// returns the embedded public key — regardless of whether that key is
/// actually one of ATTESTOR_PUBKEYS (that membership check is the
/// caller's job, in `verify_decision_attestations` below, same
/// separation as EVM's `_recoverSigner` vs. `_countValidDistinctAttestations`).
/// Returns None for anything malformed/redirected/mismatched rather than
/// erroring, so the M-of-N caller can simply skip a bad entry instead of
/// the whole check failing on one bad instruction among several.
fn parse_valid_ed25519_attestation(ed25519_ix: &Instruction, expected_message: &[u8]) -> Option<Pubkey> {
    if ed25519_ix.program_id != solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111") {
        return None;
    }

    let data = &ed25519_ix.data;
    // num_signatures: u8 at byte 0, one padding byte at byte 1, then the
    // Ed25519SignatureOffsets struct (14 bytes, all u16 LE) starting at
    // byte 2 — SIGNATURE_OFFSETS_START/SIGNATURE_OFFSETS_SERIALIZED_SIZE
    // in solana-ed25519-program's own source.
    if data.len() < 2 + 14 {
        return None;
    }
    let num_signatures = data[0];
    if num_signatures != 1 {
        return None;
    }

    let read_u16 = |offset: usize| -> u16 { u16::from_le_bytes([data[offset], data[offset + 1]]) };

    // Real vulnerability, caught by re-audit before this ever went to
    // production: the Ed25519SignatureOffsets struct lets EACH of
    // signature/public_key/message independently point at a DIFFERENT
    // instruction in the same transaction via its own
    // `*_instruction_index` field (u16::MAX means "this same
    // instruction's own inline data", any other value is an index into
    // the transaction's instruction list). The runtime's OWN Ed25519
    // verification honors those indices when deciding what bytes to
    // actually check the signature against. This function, below, reads
    // pubkey/message bytes from OFFSETS WITHIN THIS INSTRUCTION's data
    // unconditionally — if the indices pointed elsewhere, the bytes this
    // function reads and compares are NOT the bytes the runtime actually
    // verified a signature over. An attacker could construct an Ed25519
    // instruction whose real cryptographic check passes (by referencing
    // some unrelated, genuinely-signed data via non-MAX indices), while
    // placing arbitrary forged pubkey/message bytes at these offsets in
    // the current instruction's own data for this function to read — a
    // full attestation forgery with no valid attestor signature ever
    // having existed over the forged content. Requiring all three
    // indices equal u16::MAX (exactly what `new_ed25519_instruction_with_signature`
    // always sets, per solana-ed25519-program's own source) guarantees
    // the bytes this function reads are the SAME bytes the runtime's own
    // verification used — no room for redirection.
    let signature_instruction_index = read_u16(2 + 2);
    let public_key_instruction_index = read_u16(2 + 6);
    let message_instruction_index = read_u16(2 + 12);
    if signature_instruction_index != u16::MAX
        || public_key_instruction_index != u16::MAX
        || message_instruction_index != u16::MAX
    {
        return None;
    }

    let public_key_offset = read_u16(2 + 4) as usize; // 3rd field in the struct
    let message_data_offset = read_u16(2 + 8) as usize; // 5th field
    let message_data_size = read_u16(2 + 10) as usize; // 6th field

    let public_key_bytes = data.get(public_key_offset..public_key_offset + 32)?;

    let message = data.get(message_data_offset..message_data_offset + message_data_size)?;
    if message != expected_message {
        return None;
    }

    Some(Pubkey::try_from(public_key_bytes).ok()?)
}

/// M-of-N: scans the `ATTESTOR_PUBKEYS.len()` instructions immediately
/// preceding this one (relative indices -1, -2, ... — the exact set of
/// slots `attested_settle`'s caller must fill with real Ed25519-verify
/// instructions, one per co-signing attestor, right before submitting
/// AttestedSettle) and requires at least `ATTESTOR_THRESHOLD` of them to
/// be genuine, non-redirected Ed25519 instructions over exactly the
/// expected message, from DISTINCT keys in ATTESTOR_PUBKEYS. Same
/// "distinct signer" dedup reasoning as EVM's
/// `_countValidDistinctAttestations` — a single attestor repeating its
/// own valid signature across multiple of the scanned slots must not
/// count more than once toward the threshold.
fn verify_decision_attestations(
    program_id: &Pubkey,
    instructions_sysvar_info: &AccountInfo,
    expected_body: &DecisionRelayBody,
) -> ProgramResult {
    let expected_message = decision_attestation_message(program_id, expected_body);

    let mut candidates: Vec<Pubkey> = Vec::with_capacity(ATTESTOR_PUBKEYS.len());
    for slot in 1..=ATTESTOR_PUBKEYS.len() {
        let ed25519_ix = match get_instruction_relative(-(slot as i64), instructions_sysvar_info) {
            Ok(ix) => ix,
            Err(_) => break, // fewer preceding instructions than attestor slots — nothing further to scan
        };
        if let Some(signer) = parse_valid_ed25519_attestation(&ed25519_ix, &expected_message) {
            candidates.push(signer);
        }
    }

    if count_distinct_registered_signers(candidates.into_iter()) >= ATTESTOR_THRESHOLD {
        Ok(())
    } else {
        Err(ProgramError::InvalidArgument)
    }
}

/// M-of-N: counts DISTINCT signers from `candidates` that are actually
/// in ATTESTOR_PUBKEYS — a candidate not in that set is simply ignored
/// (not an error), and the same signer appearing more than once in
/// `candidates` (e.g. a single attestor's signature occupying more than
/// one of the scanned instruction slots) counts only once. Split out as
/// a pure function, independent of any sysvar/Instruction parsing, so
/// this specific counting logic is directly unit-testable — mirrors
/// DecisionRelay.sol's `_countValidDistinctAttestations` on the EVM
/// side, same reasoning.
fn count_distinct_registered_signers(candidates: impl Iterator<Item = Pubkey>) -> usize {
    let mut seen: Vec<Pubkey> = Vec::with_capacity(ATTESTOR_PUBKEYS.len());
    for candidate in candidates {
        if ATTESTOR_PUBKEYS.contains(&candidate) && !seen.contains(&candidate) {
            seen.push(candidate);
        }
    }
    seen.len()
}

/// Returns the account metas `handle()` will need for this specific
/// message — computed by decoding the message body directly (the only
/// data available at this stage; no other accounts can be read here).
///
/// Accounts:
/// 0. `[]` The fixed PDA at HANDLE_ACCOUNT_METAS_PDA_SEEDS (unused beyond
///    satisfying the interface's account-passing convention).
fn handle_account_metas(program_id: &Pubkey, handle_ix: HandleInstruction) -> ProgramResult {
    let body = DecisionRelayBody::try_from_slice(&handle_ix.message)
        .map_err(|_| ProgramError::BorshIoError)?;

    let account_metas = required_handle_account_metas(program_id, &body);

    let bytes = borsh::to_vec(&SimulationReturnData::new(account_metas))
        .map_err(|_| ProgramError::BorshIoError)?;
    solana_program::program::set_return_data(&bytes[..]);
    Ok(())
}

/// Pure account-list builder shared by `handle_account_metas` (which wraps
/// this for the syscall-based simulation response) and, below, a unit test
/// asserting the exact regression that caused a real production incident —
/// see `handle`'s doc comment for the full story. Split out so the account
/// list itself is testable without a Solana runtime/syscall context.
fn required_handle_account_metas(program_id: &Pubkey, body: &DecisionRelayBody) -> Vec<SerializableAccountMeta> {
    let (storage_key, _) = Pubkey::find_program_address(decision_relay_storage_pda_seeds!(), program_id);

    // Must match handle()'s account order exactly (minus process_authority,
    // which the Mailbox always prepends itself before calling Handle) -
    // storage, escrow_program. handle() is notification-only now (see its
    // doc comment) and no longer touches case/claimant/respondent/
    // escrow_authority at all — those moved to attested_settle, which
    // Anchor's backend calls directly, not through Hyperlane/this
    // account-metas query. No payer/system_program/processed_decision
    // account either — see handle()'s doc comment for why (a
    // relayer-payer-owned dynamic account is categorically rejected by
    // Hyperlane's own Sealevel relayer, "Dynamic account metas contain
    // payer account").
    vec![
        AccountMeta::new_readonly(storage_key, false).into(),
        AccountMeta::new_readonly(body.escrow_program, false).into(),
    ]
}

#[cfg(test)]
mod handle_account_metas_tests {
    use super::*;

    /// Regression test for a real production incident: `handle_account_metas`
    /// used to return `AccountMeta::new(RELAYER_PAYER, true)`, a dynamic
    /// account matching the relayer's own configured payer pubkey.
    /// Hyperlane's Sealevel relayer unconditionally rejects any recipient
    /// dynamic account meta whose pubkey equals its payer
    /// (`sanitize_dynamic_accounts` in `chains/hyperlane-sealevel/src/utils.rs`
    /// — a Solana same-account-signer-escalation guard, not a bug to work
    /// around). Confirmed live: every relayer simulation of a real inbound
    /// message failed with "Dynamic account metas contain payer account"
    /// before a transaction was ever attempted. Since the relayer's actual
    /// payer pubkey is runtime config unknown to this program, the only
    /// structurally safe fix is for `handle()` to need no payer at all — this
    /// test asserts the dynamic account list therefore contains zero signer
    /// accounts (only the Mailbox-prepended `process_authority`, which this
    /// function does not return, is ever a signer).
    #[test]
    fn handle_account_metas_never_includes_a_signer() {
        let program_id = Pubkey::new_unique();
        let body = DecisionRelayBody {
            case_id: "CASE-TEST-1".to_string(),
            claimant: Pubkey::new_unique(),
            respondent: Pubkey::new_unique(),
            escrow_program: Pubkey::new_unique(),
            claimant_share_bps: 10_000,
            respondent_share_bps: 0,
            decision_hash: [7u8; 32],
        };

        let metas = required_handle_account_metas(&program_id, &body);

        assert_eq!(metas.len(), 2, "unexpected account count — check handle()'s doc comment stays in sync");
        for meta in metas {
            let meta: AccountMeta = meta.into();
            assert!(
                !meta.is_signer,
                "handle_account_metas must never return a signer account — a relayer-payer-owned \
                 signer here is exactly what caused \"Dynamic account metas contain payer account\""
            );
        }
    }
}

#[cfg(test)]
mod attestation_tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;
    use solana_ed25519_program::new_ed25519_instruction_with_signature;

    fn sample_body() -> DecisionRelayBody {
        DecisionRelayBody {
            case_id: "CASE-ATTEST-TEST-1".to_string(),
            claimant: Pubkey::new_unique(),
            respondent: Pubkey::new_unique(),
            escrow_program: Pubkey::new_unique(),
            claimant_share_bps: 7_500,
            respondent_share_bps: 2_500,
            decision_hash: [9u8; 32],
        }
    }

    /// Builds a real Ed25519 native-program instruction the exact way
    /// `solana-ed25519-program` (the crate the Solana runtime's own
    /// tooling uses) does, then confirms `parse_valid_ed25519_attestation`
    /// correctly parses it and returns the embedded signer key when the
    /// message matches. This is the strongest check available short of a
    /// live on-chain transaction: it proves the hand-rolled offset
    /// parsing agrees with the real wire format, not just with itself.
    #[test]
    fn parse_valid_ed25519_attestation_accepts_real_signature_matching_message() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key_bytes = signing_key.verifying_key().to_bytes();

        let program_id = Pubkey::new_unique();
        let body = sample_body();
        let message = decision_attestation_message(&program_id, &body);
        let signature = signing_key.sign(&message).to_bytes();

        let ix = new_ed25519_instruction_with_signature(&message, &signature, &verifying_key_bytes);

        let result = parse_valid_ed25519_attestation(&ix, &message);
        assert_eq!(result, Some(Pubkey::from(verifying_key_bytes)));
    }

    /// The M-of-N membership check lives in `count_distinct_registered_signers`,
    /// not in parsing itself — this confirms a real, validly-parsed
    /// signer that ISN'T in ATTESTOR_PUBKEYS contributes zero toward the
    /// threshold, i.e. a real signature from a non-attestor key can
    /// never help authorize a settlement.
    #[test]
    fn count_distinct_registered_signers_ignores_non_attestor_keys() {
        let stranger = Pubkey::new_unique();
        for known in ATTESTOR_PUBKEYS.iter() {
            assert_ne!(&stranger, known, "test key collided with a real attestor constant — regenerate");
        }
        assert_eq!(count_distinct_registered_signers(std::iter::once(stranger)), 0);
    }

    /// Same real attestor-shaped setup, but the on-chain `body` passed to
    /// verification differs from what was actually signed (tampered
    /// content) — must be rejected (parsing returns None) even though the
    /// instruction itself is perfectly well-formed and really
    /// Ed25519-verified by the runtime.
    #[test]
    fn parse_valid_ed25519_attestation_rejects_tampered_content() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key_bytes = signing_key.verifying_key().to_bytes();

        let program_id = Pubkey::new_unique();
        let signed_body = sample_body();
        let message = decision_attestation_message(&program_id, &signed_body);
        let signature = signing_key.sign(&message).to_bytes();
        let ix = new_ed25519_instruction_with_signature(&message, &signature, &verifying_key_bytes);

        let mut tampered_body = signed_body;
        tampered_body.claimant_share_bps = 10_000;
        tampered_body.respondent_share_bps = 0;
        let tampered_message = decision_attestation_message(&program_id, &tampered_body);

        let result = parse_valid_ed25519_attestation(&ix, &tampered_message);
        assert_eq!(result, None, "must reject when the expected message doesn't match what was actually signed");
    }

    /// A signature genuinely signed for a DIFFERENT decision-relay
    /// program deployment must not verify against this one — proves the
    /// program-id binding (added alongside cluster binding after a
    /// re-audit asked for "defense in depth") actually does something,
    /// not just that it's present in the message. Simulated here by
    /// signing for one program_id and checking against the message
    /// computed for a different one — exactly what `verify_decision_attestations`
    /// does internally by always recomputing the expected message from
    /// its own `program_id` argument.
    #[test]
    fn parse_valid_ed25519_attestation_rejects_message_for_different_program_id() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key_bytes = signing_key.verifying_key().to_bytes();

        let signed_for_program_id = Pubkey::new_unique();
        let body = sample_body();
        let message = decision_attestation_message(&signed_for_program_id, &body);
        let signature = signing_key.sign(&message).to_bytes();
        let ix = new_ed25519_instruction_with_signature(&message, &signature, &verifying_key_bytes);

        let different_program_id = Pubkey::new_unique();
        let expected_message_for_different_program = decision_attestation_message(&different_program_id, &body);

        let result = parse_valid_ed25519_attestation(&ix, &expected_message_for_different_program);
        assert_eq!(result, None, "must reject a signature minted for a different program_id");
    }

    #[test]
    fn parse_valid_ed25519_attestation_rejects_non_ed25519_program() {
        let body = sample_body();
        let program_id = Pubkey::new_unique();
        let message = decision_attestation_message(&program_id, &body);
        let fake_ix = Instruction {
            program_id: Pubkey::new_unique(),
            accounts: vec![],
            data: vec![0u8; 200],
        };
        let result = parse_valid_ed25519_attestation(&fake_ix, &message);
        assert_eq!(result, None, "must reject an instruction that isn't really the Ed25519 native program");
    }

    /// The core M-of-N guarantee: two DISTINCT real attestor signatures
    /// (both actually in ATTESTOR_PUBKEYS) count as 2 toward the
    /// threshold — the ordinary happy path this whole mechanism exists
    /// to support. Uses ATTESTOR_PUBKEYS directly since
    /// count_distinct_registered_signers checks against that real
    /// constant, not an injectable set — this test only makes sense
    /// paired with the real deployed values.
    #[test]
    fn count_distinct_registered_signers_counts_distinct_known_signers() {
        assert_eq!(ATTESTOR_PUBKEYS.len(), 2, "test assumes exactly 2 configured attestors — update if that changes");
        let count = count_distinct_registered_signers(ATTESTOR_PUBKEYS.into_iter());
        assert_eq!(count, 2);
    }

    /// The same registered signer appearing twice in the candidate list
    /// (e.g. because a single attestor's Ed25519 instruction happened to
    /// occupy more than one scanned slot) must count only once — a
    /// single attestor repeating itself must never be able to satisfy a
    /// 2-of-2 (or higher) threshold alone.
    #[test]
    fn count_distinct_registered_signers_does_not_double_count_duplicates() {
        let one_signer = ATTESTOR_PUBKEYS[0];
        let count = count_distinct_registered_signers([one_signer, one_signer, one_signer].into_iter());
        assert_eq!(count, 1);
    }

    /// Adversarial regression test for the real vulnerability a re-audit
    /// caught before this ever reached production — see
    /// `verify_decision_attestation`'s own doc comment on the
    /// `*_instruction_index` fields for the full attack.
    ///
    /// 1. Build a real Ed25519 instruction with genuine runtime-verifiable
    ///    crypto — a real signature, over a real (but UNRELATED/dummy)
    ///    message, from a real (but non-attestor) key. This is the part
    ///    Solana's own runtime actually cryptographically checks.
    /// 2. Redirect `public_key_instruction_index` and
    ///    `message_instruction_index` away from `u16::MAX` (pointing at
    ///    instruction index 0 instead — "look elsewhere", simulating an
    ///    attacker pointing at some other instruction the runtime would
    ///    resolve differently).
    /// 3. Append FORGED bytes to this same instruction's own data:
    ///    ATTESTOR_PUBKEY's real bytes and the real, expected attestation
    ///    message for `sample_body()` — content that was never actually
    ///    signed by anyone, placed in unused trailing bytes of the
    ///    instruction.
    /// 4. Point `public_key_offset`/`message_data_offset` at those forged
    ///    trailing bytes instead of the original genuinely-verified ones.
    ///
    /// Before this fix, `parse_valid_ed25519_attestation` (then still
    /// named `verify_decision_attestation`) would read the forged bytes
    /// (matching a real ATTESTOR_PUBKEYS entry and the expected message)
    /// and accept this as a valid attestation — a full forgery with no
    /// real attestor signature ever existing over the claimed decision.
    /// The fix must reject this purely because the instruction indices
    /// aren't all `u16::MAX`, independent of what bytes happen to be at
    /// the (attacker-chosen) offsets.
    #[test]
    fn parse_valid_ed25519_attestation_rejects_cross_instruction_redirection() {
        let mut csprng = OsRng;
        let unrelated_signing_key = SigningKey::generate(&mut csprng);
        let unrelated_verifying_key_bytes = unrelated_signing_key.verifying_key().to_bytes();
        let unrelated_message = b"totally unrelated dummy message, not a decision attestation".to_vec();
        let unrelated_signature = unrelated_signing_key.sign(&unrelated_message).to_bytes();

        let mut ix = new_ed25519_instruction_with_signature(&unrelated_message, &unrelated_signature, &unrelated_verifying_key_bytes);

        let program_id = Pubkey::new_unique();
        let target_body = sample_body();
        let forged_message = decision_attestation_message(&program_id, &target_body);
        let forged_pubkey = ATTESTOR_PUBKEYS[0].to_bytes();

        // Append the forged bytes after the genuinely-verified data —
        // pubkey first, then message, recording where each landed.
        let forged_pubkey_offset = ix.data.len() as u16;
        ix.data.extend_from_slice(&forged_pubkey);
        let forged_message_offset = ix.data.len() as u16;
        ix.data.extend_from_slice(&forged_message);

        // Redirect the offsets to the forged bytes AND the instruction
        // indices away from u16::MAX (self) — exactly the two things a
        // real attacker needs to control to pull this off. Field byte
        // positions confirmed directly from solana-ed25519-program's own
        // Ed25519SignatureOffsets struct (see parse_valid_ed25519_attestation's
        // doc comment): public_key_offset at 2+4, public_key_instruction_index
        // at 2+6, message_data_offset at 2+8, message_data_size at 2+10,
        // message_instruction_index at 2+12.
        ix.data[2 + 4..2 + 6].copy_from_slice(&forged_pubkey_offset.to_le_bytes());
        ix.data[2 + 6..2 + 8].copy_from_slice(&0u16.to_le_bytes()); // public_key_instruction_index: redirected away from MAX
        ix.data[2 + 8..2 + 10].copy_from_slice(&forged_message_offset.to_le_bytes());
        ix.data[2 + 10..2 + 12].copy_from_slice(&(forged_message.len() as u16).to_le_bytes());
        ix.data[2 + 12..2 + 14].copy_from_slice(&0u16.to_le_bytes()); // message_instruction_index: redirected away from MAX

        let result = parse_valid_ed25519_attestation(&ix, &forged_message);
        assert_eq!(
            result, None,
            "must reject when public_key/message_instruction_index don't point at this instruction's own \
             data (u16::MAX) — accepting this would mean forged bytes placed anywhere in the instruction \
             data can masquerade as an attestation the runtime never actually verified"
        );
    }
}
