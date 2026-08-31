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

/// Handles an inbound DECISION_RELAY message: verifies the Mailbox's
/// process authority, decodes the body, then CPIs into escrow.settle()
/// with this program's escrow-authority PDA signing as `adjudicator`.
///
/// Destination-side settlement idempotency does NOT use a
/// decision-relay-owned PDA here (a prior version did — see git history
/// for "processed-decision PDA" — and required a relayer-funded payer
/// account to create it). That design was structurally incompatible with
/// Hyperlane's own Sealevel relayer: its `sanitize_dynamic_accounts`
/// unconditionally rejects any recipient-declared dynamic account that
/// matches the relayer's payer pubkey (chains/hyperlane-sealevel's
/// `utils.rs` — a hard anti-signer-smuggling rule, not a bug, since a
/// repeated pubkey in a Solana transaction's account list becomes a
/// signer everywhere it appears if it's a signer anywhere), so
/// `handle_account_metas` could never legally advertise a payer account
/// at all. Confirmed live: every relayer simulation of a real inbound
/// message failed with "Dynamic account metas contain payer account"
/// before a single transaction was ever attempted.
///
/// Idempotency here instead comes from two guarantees that already
/// exist and need no new account: the Mailbox's own processed-message
/// PDA (keyed by message_id, created in inbox_process before this CPI
/// runs) rejects exact message replay, and escrow's own
/// `case.status`/`AlreadySettled` guard (chains/solana/programs/escrow)
/// rejects a second settle() for the same case regardless of which
/// message/dispatch triggered it — a retry after a lost local record
/// (two different messages, same case) hits `AlreadySettled` in
/// escrow's own program and reverts cleanly. That covers the same
/// "can't settle twice" requirement the EVM side's
/// `processedDecisions[proofHash]` mapping covers, without requiring any
/// party's key to be advertised as a dynamic recipient account. Since no
/// account is created here anymore, no payer or system program is
/// needed in this instruction at all.
///
/// Accounts:
/// 0. `[]` Process authority specific to this program (signer).
/// 1. `[]` Storage PDA account.
/// 2. `[executable]` Escrow program.
/// 3. `[writeable]` Case PDA (escrow's `["case", case_id]`).
/// 4. `[writeable]` Claimant account (from the message body).
/// 5. `[writeable]` Respondent account (from the message body).
/// 6. `[]` This program's escrow-authority PDA.
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
    let case_info = next_account_info(accounts_iter)?;
    let claimant_info = next_account_info(accounts_iter)?;
    let respondent_info = next_account_info(accounts_iter)?;
    let escrow_authority_info = next_account_info(accounts_iter)?;

    let body = DecisionRelayBody::try_from_slice(&handle_ix.message)
        .map_err(|_| ProgramError::BorshIoError)?;

    if body.escrow_program != storage.escrow_program {
        return Err(ProgramError::InvalidArgument);
    }
    if claimant_info.key != &body.claimant || respondent_info.key != &body.respondent {
        return Err(ProgramError::InvalidArgument);
    }

    let (expected_case_key, _case_bump) = Pubkey::find_program_address(
        &[b"case", body.case_id.as_bytes()],
        escrow_program_info.key,
    );
    if case_info.key != &expected_case_key {
        return Err(ProgramError::InvalidArgument);
    }

    let (expected_escrow_authority_key, escrow_authority_bump) =
        Pubkey::find_program_address(decision_relay_escrow_authority_pda_seeds!(), program_id);
    if escrow_authority_info.key != &expected_escrow_authority_key {
        return Err(ProgramError::InvalidArgument);
    }

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

    msg!("decision-relay: settled case {}", body.case_id);
    Ok(())
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
    let (case_key, _) =
        Pubkey::find_program_address(&[b"case", body.case_id.as_bytes()], &body.escrow_program);
    let (escrow_authority_key, _) =
        Pubkey::find_program_address(decision_relay_escrow_authority_pda_seeds!(), program_id);

    // Must match handle()'s account order exactly (minus process_authority,
    // which the Mailbox always prepends itself before calling Handle) -
    // storage, escrow_program, case, claimant, respondent, escrow_authority.
    // No payer/system_program/processed_decision account anymore — see
    // handle()'s doc comment for why (a relayer-payer-owned dynamic
    // account is categorically rejected by Hyperlane's own Sealevel
    // relayer, "Dynamic account metas contain payer account").
    // escrow_program was missing here for a while, which silently shifted
    // every account after it by one slot and made handle() fail with
    // InvalidArgument on real inbound messages - confirmed live via relayer
    // simulation logs, not just inferred from reading the two functions.
    vec![
        AccountMeta::new_readonly(storage_key, false).into(),
        AccountMeta::new_readonly(body.escrow_program, false).into(),
        AccountMeta::new(case_key, false).into(),
        AccountMeta::new(body.claimant, false).into(),
        AccountMeta::new(body.respondent, false).into(),
        AccountMeta::new_readonly(escrow_authority_key, false).into(),
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

        assert_eq!(metas.len(), 6, "unexpected account count — check handle()'s doc comment stays in sync");
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
