//! Real local coverage for `hyperlane-sealevel-multisig-ism-message-id` —
//! the program `decision-relay`'s `InterchainSecurityModule` handler now
//! points at as `REAL_MULTISIG_ISM`
//! (chains/solana/programs/decision-relay/src/lib.rs:80,
//! 5DLNSFtzEJBTipvvSvNPzvAFpx8uwf96qEjygAwT6ncY on Solana Testnet), whose
//! 8-step Testnet proof checklist (chains/solana/ISM_MIGRATION.md) has
//! never actually been run. This file is that proof's steps 2, 6 (partial
//! — see below), and 7, run for real locally instead of by spending live
//! Testnet transactions.
//!
//! ## Why solana-program-test (BanksClient), not solana-test-validator
//!
//! `run-decision-relay-localnet-e2e.ts` (this directory's existing
//! pattern) uses a real `solana-test-validator` because `attested_settle`
//! needs the *runtime's* own Ed25519 native-program instruction sysvar
//! introspection, which only a full validator provides end to end via RPC.
//! The multisig ISM's `Verify` instruction has no such requirement — it's
//! a single instruction whose entire job is "parse this metadata, recover
//! ECDSA signers, check quorum," and Hyperlane's own upstream test suite
//! for this exact program (`hyperlane-monorepo`'s
//! `rust/sealevel/programs/ism/multisig-ism-message-id/tests/functional.rs`,
//! pinned rev b58c7eb7275cd61467805f8841d26682118b6f1b, fetched by Cargo
//! as this repo's own git dependency — see Cargo.toml) tests it exactly
//! this way: `solana_program_test::ProgramTest` with `processor!`, which
//! invokes the real `process_instruction` entrypoint in-process against a
//! real (simulated) Bank — not a mock of the program, a mock of the
//! network transport around it. `initialize`/`set_validators_and_threshold`
//! below are copied nearly verbatim from that upstream file (same
//! instruction encoding, same PDA seeds, same account lists) because they
//! are cheap, already-correct scaffolding — not because the negative-case
//! assertions after them exist upstream (they don't; upstream only tests
//! the single happy path).
//!
//! This proves the real on-chain quorum/signature-recovery/metadata-parsing
//! logic. It does NOT exercise a full Mailbox `process()` CPI call (Mailbox
//! account init, Inbox PDA, ValidatorAnnounce, `decision-relay::handle()`
//! CPI target) — see chains/solana/ISM_MIGRATION.md and this crate's own
//! summary in chains/solana/tests/README-localnet-tests.md for exactly
//! what that gap is and why closing it fully was out of this task's budget.
//!
//! Run: `cargo test -p ism-localnet-tests` (from `chains/solana`).

use account_utils::DiscriminatorEncode;
use ecdsa_signature::EcdsaSignature;
use hyperlane_core::Encode;
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_multisig_ism_message_id::{
    access_control_pda_seeds, domain_data_pda_seeds,
    instruction::{Domained, Instruction as MultisigIsmProgramInstruction, ValidatorsAndThreshold},
    processor::process_instruction,
};
use multisig_ism::test_data::get_multisig_ism_test_data;
use multisig_ism::MultisigIsmMessageIdMetadata;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    hash::Hash,
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
};
use solana_sdk::message::Message;
use solana_program_test::*;
use solana_sdk::{
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};

fn multisig_ism_message_id_id() -> Pubkey {
    // A throwaway program id for this in-process test only — never
    // deployed, never touched by anything real. The live deployment's own
    // id (5DLNSFtzEJBTipvvSvNPzvAFpx8uwf96qEjygAwT6ncY) is irrelevant here
    // since ProgramTest loads the entrypoint function directly, not a
    // deployed account.
    pubkey!("2YjtZDiUoptoSsA5eVrDCcX6wxNK6YoEVW7y82x5Z2fw")
}

async fn initialize(
    program_id: Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
) -> Result<Pubkey, BanksClientError> {
    let (access_control_pda_key, _) = Pubkey::find_program_address(access_control_pda_seeds!(), &program_id);
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &MultisigIsmProgramInstruction::Initialize.encode().unwrap(),
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new(access_control_pda_key, false),
                AccountMeta::new_readonly(solana_system_interface::program::ID, false),
            ],
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;
    Ok(access_control_pda_key)
}

async fn set_validators_and_threshold(
    program_id: Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    access_control_pda_key: Pubkey,
    domain: u32,
    validators_and_threshold: ValidatorsAndThreshold,
) -> Result<(), BanksClientError> {
    let (domain_data_pda_key, _) = Pubkey::find_program_address(domain_data_pda_seeds!(domain), &program_id);
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &MultisigIsmProgramInstruction::SetValidatorsAndThreshold(Domained {
                domain,
                data: validators_and_threshold,
            })
            .encode()
            .unwrap(),
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(access_control_pda_key, false),
                AccountMeta::new(domain_data_pda_key, false),
                AccountMeta::new_readonly(solana_system_interface::program::ID, false),
            ],
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await
}

/// Runs `Verify` with the given raw metadata bytes and message, returning
/// the simulation logs on success or the transaction error on failure.
/// Mirrors upstream's `test_ism_verify` exactly for the account-metas
/// simulate-then-execute dance (`VerifyAccountMetas` is itself a real
/// on-chain instruction the Mailbox's relayer-simulation step depends on
/// — ISM_MIGRATION.md's proof-checklist step 3).
async fn try_verify(
    program_id: Pubkey,
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    metadata: Vec<u8>,
    message: Vec<u8>,
) -> Result<Vec<String>, TransactionError> {
    let verify_instruction = VerifyInstruction { metadata, message };

    let (account_metas_pda_key, _) = Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &program_id);
    let sim = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                program_id,
                &InterchainSecurityModuleInstruction::VerifyAccountMetas(verify_instruction.clone())
                    .encode()
                    .unwrap(),
                vec![AccountMeta::new(account_metas_pda_key, false)],
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();
    let details = sim.simulation_details.expect("VerifyAccountMetas must simulate");
    if let Some(err) = sim.result.and_then(|r| r.err()) {
        return Err(err);
    }
    let account_metas: Vec<SerializableAccountMeta> =
        SimulationReturnData::<Vec<SerializableAccountMeta>>::try_from_slice(
            &details.return_data.expect("VerifyAccountMetas must return data").data,
        )
        .unwrap()
        .return_data;
    let account_metas: Vec<AccountMeta> = account_metas.into_iter().map(Into::into).collect();

    let sim2 = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                program_id,
                &InterchainSecurityModuleInstruction::Verify(verify_instruction).encode().unwrap(),
                account_metas,
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();
    match sim2.result {
        Some(Ok(())) => Ok(sim2.simulation_details.unwrap().logs),
        Some(Err(e)) => Err(e),
        None => panic!("simulation produced no result"),
    }
}

use borsh::BorshDeserialize;

async fn setup() -> (Pubkey, BanksClient, Keypair, Hash, Pubkey) {
    let program_id = multisig_ism_message_id_id();
    let (banks_client, payer, recent_blockhash) =
        ProgramTest::new("ism_localnet_tests", program_id, processor!(process_instruction))
            .start()
            .await;
    (program_id, banks_client, payer, recent_blockhash, program_id)
}

/// Scenario 1 — first delivery: a genuinely constructed multisig-ISM
/// `Verify` call with 2-of-3 *real* ECDSA signatures (Hyperlane's own
/// upstream fixture keys/signatures, `multisig_ism::test_data`) over the
/// real EVM-compatible checkpoint digest is accepted. This is
/// ISM_MIGRATION.md proof-checklist step 4's logic (the real "does a
/// legitimately signed message get accepted" check), run against the real
/// entrypoint rather than over the wire against solana-test-validator.
#[tokio::test]
async fn scenario_1_first_delivery_accepted_with_quorum() {
    let (program_id, mut banks_client, payer, recent_blockhash, _) = setup().await;
    let access_control_pda_key = initialize(program_id, &mut banks_client, &payer, recent_blockhash).await.unwrap();

    let data = get_multisig_ism_test_data();
    let origin_domain = data.message.origin;
    set_validators_and_threshold(
        program_id,
        &mut banks_client,
        &payer,
        recent_blockhash,
        access_control_pda_key,
        origin_domain,
        ValidatorsAndThreshold { validators: data.validators.clone(), threshold: 2 },
    )
    .await
    .unwrap();

    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: data.checkpoint.merkle_tree_hook_address,
        merkle_root: data.checkpoint.root,
        merkle_index: data.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&data.signatures[0]).unwrap(),
            EcdsaSignature::from_bytes(&data.signatures[1]).unwrap(),
        ],
    }
    .to_vec();

    let logs = try_verify(program_id, &mut banks_client, &payer, recent_blockhash, metadata, data.message.to_vec())
        .await
        .expect("2-of-3 real signatures over the real checkpoint must be accepted");
    assert_eq!(logs.last().unwrap(), &format!("Program {} success", program_id));
}

/// Scenario 5 — validator quorum loss: only 1-of-3 real, validly-formed
/// signatures (not 2 forged ones — a real signature from a real validator,
/// just not enough of them) must be rejected with `ThresholdNotMet`. This
/// is the actual security property ISM_MIGRATION.md's step 7 (forged-origin
/// rejection) and the "quorum loss" scenario both come down to: an
/// insufficient validator set can't force acceptance.
#[tokio::test]
async fn scenario_5_quorum_loss_rejected() {
    let (program_id, mut banks_client, payer, recent_blockhash, _) = setup().await;
    let access_control_pda_key = initialize(program_id, &mut banks_client, &payer, recent_blockhash).await.unwrap();

    let data = get_multisig_ism_test_data();
    set_validators_and_threshold(
        program_id,
        &mut banks_client,
        &payer,
        recent_blockhash,
        access_control_pda_key,
        data.message.origin,
        ValidatorsAndThreshold { validators: data.validators.clone(), threshold: 2 },
    )
    .await
    .unwrap();

    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: data.checkpoint.merkle_tree_hook_address,
        merkle_root: data.checkpoint.root,
        merkle_index: data.checkpoint.index,
        validator_signatures: vec![EcdsaSignature::from_bytes(&data.signatures[0]).unwrap()],
    }
    .to_vec();

    let err = try_verify(program_id, &mut banks_client, &payer, recent_blockhash, metadata, data.message.to_vec())
        .await
        .expect_err("1-of-3 (below the 2-of-3 threshold) must be rejected");
    assert_custom_error(&err, 7 /* Error::ThresholdNotMet, chains/solana ISM_MIGRATION notes this is the same code Hyperlane's own crate defines */);
}

/// A signature from a real key that is genuinely NOT in the registered
/// validator set (not a corrupted/forged signature, a real one from an
/// outside key) must not count toward quorum even paired with one real
/// registered signature — same "non-attestor doesn't count" property the
/// decision-relay localnet suite already proves for `attested_settle`,
/// proven here for the ISM's own independent validator set.
#[tokio::test]
async fn scenario_5b_non_validator_signature_does_not_count_toward_quorum() {
    let (program_id, mut banks_client, payer, recent_blockhash, _) = setup().await;
    let access_control_pda_key = initialize(program_id, &mut banks_client, &payer, recent_blockhash).await.unwrap();

    let data = get_multisig_ism_test_data();
    // Register only validators 0 and 1 (threshold 2) — validator 2's real
    // signature is then, by construction, from a real key outside the set.
    set_validators_and_threshold(
        program_id,
        &mut banks_client,
        &payer,
        recent_blockhash,
        access_control_pda_key,
        data.message.origin,
        ValidatorsAndThreshold { validators: vec![data.validators[0], data.validators[1]], threshold: 2 },
    )
    .await
    .unwrap();

    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: data.checkpoint.merkle_tree_hook_address,
        merkle_root: data.checkpoint.root,
        merkle_index: data.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&data.signatures[0]).unwrap(),
            EcdsaSignature::from_bytes(&data.signatures[2]).unwrap(), // real sig, real key, NOT registered
        ],
    }
    .to_vec();

    let err = try_verify(program_id, &mut banks_client, &payer, recent_blockhash, metadata, data.message.to_vec())
        .await
        .expect_err("a real signature from an unregistered validator must not satisfy quorum");
    assert_custom_error(&err, 7);
}

/// Scenario 4 — malformed metadata: metadata whose signature-bytes region
/// is not an exact multiple of the 65-byte ECDSA signature length must be
/// rejected by parsing itself (`InvalidMetadata`), before any cryptographic
/// check even runs. This is real wire-format validation in the real
/// program, not a hand-rolled assertion about what "should" happen.
#[tokio::test]
async fn scenario_4_malformed_metadata_rejected() {
    let (program_id, mut banks_client, payer, recent_blockhash, _) = setup().await;
    let access_control_pda_key = initialize(program_id, &mut banks_client, &payer, recent_blockhash).await.unwrap();

    let data = get_multisig_ism_test_data();
    set_validators_and_threshold(
        program_id,
        &mut banks_client,
        &payer,
        recent_blockhash,
        access_control_pda_key,
        data.message.origin,
        ValidatorsAndThreshold { validators: data.validators.clone(), threshold: 2 },
    )
    .await
    .unwrap();

    let mut metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: data.checkpoint.merkle_tree_hook_address,
        merkle_root: data.checkpoint.root,
        merkle_index: data.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&data.signatures[0]).unwrap(),
            EcdsaSignature::from_bytes(&data.signatures[1]).unwrap(),
        ],
    }
    .to_vec();
    // Truncate 10 bytes out of the signature region -> no longer a
    // multiple of 65 bytes -> MultisigIsmMessageIdMetadata::try_from must
    // reject it as InvalidMetadata (see metadata.rs's own length check).
    metadata.truncate(metadata.len() - 10);

    let err = try_verify(program_id, &mut banks_client, &payer, recent_blockhash, metadata, data.message.to_vec())
        .await
        .expect_err("truncated/malformed metadata bytes must be rejected");
    assert_custom_error(&err, 10 /* Error::InvalidMetadata */);
}

/// A metadata blob with a corrupted (bit-flipped) signature — still the
/// right length and shape, so it parses fine, but recovers to a signer
/// that isn't in the validator set — must also be rejected. Complements
/// scenario 4 (structurally malformed) with content-level malformation.
#[tokio::test]
async fn scenario_4b_corrupted_signature_bytes_rejected() {
    let (program_id, mut banks_client, payer, recent_blockhash, _) = setup().await;
    let access_control_pda_key = initialize(program_id, &mut banks_client, &payer, recent_blockhash).await.unwrap();

    let data = get_multisig_ism_test_data();
    set_validators_and_threshold(
        program_id,
        &mut banks_client,
        &payer,
        recent_blockhash,
        access_control_pda_key,
        data.message.origin,
        ValidatorsAndThreshold { validators: data.validators.clone(), threshold: 2 },
    )
    .await
    .unwrap();

    let mut corrupted_sig_0 = data.signatures[0].clone();
    corrupted_sig_0[10] ^= 0xFF; // flip bits inside the signature payload, not the recovery id byte

    let metadata = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: data.checkpoint.merkle_tree_hook_address,
        merkle_root: data.checkpoint.root,
        merkle_index: data.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&corrupted_sig_0).unwrap(),
            EcdsaSignature::from_bytes(&data.signatures[1]).unwrap(),
        ],
    }
    .to_vec();

    let err = try_verify(program_id, &mut banks_client, &payer, recent_blockhash, metadata, data.message.to_vec())
        .await
        .expect_err("a corrupted signature must not recover to a registered validator");
    // Either outcome is an honest rejection: the corrupted bytes may fail
    // recovery outright (InvalidSignature=6) or recover to some address
    // that isn't in the validator set (ThresholdNotMet=7, since only 1
    // valid signature remains against threshold 2).
    assert!(matches!(custom_error_code(&err), Some(6) | Some(7)), "expected InvalidSignature or ThresholdNotMet, got {err:?}");
}

/// Scenario 6 (recovery): after a rejected quorum-loss attempt (scenario
/// 5) against the SAME domain configuration, a second `Verify` call with a
/// different, sufficient pair of real signatures (validators 0 and 2
/// instead of 0 and 1) succeeds. Proves recovery is just "try again with
/// enough real signatures" — there is no additional on-chain state this
/// stateless `Verify` instruction needs reset between attempts (unlike
/// Mailbox's own `Processed` PDA or decision-relay's `ReplayGuard`, which
/// gate delivery *idempotency*, not signature sufficiency — see this
/// file's own doc comment and README-localnet-tests.md for why replay
/// itself isn't tested at this layer).
#[tokio::test]
async fn scenario_6_recovery_after_quorum_loss_with_sufficient_signatures() {
    let (program_id, mut banks_client, payer, recent_blockhash, _) = setup().await;
    let access_control_pda_key = initialize(program_id, &mut banks_client, &payer, recent_blockhash).await.unwrap();

    let data = get_multisig_ism_test_data();
    set_validators_and_threshold(
        program_id,
        &mut banks_client,
        &payer,
        recent_blockhash,
        access_control_pda_key,
        data.message.origin,
        ValidatorsAndThreshold { validators: data.validators.clone(), threshold: 2 },
    )
    .await
    .unwrap();

    // First attempt: only 1 signature -> real rejection (the "quorum loss").
    let insufficient = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: data.checkpoint.merkle_tree_hook_address,
        merkle_root: data.checkpoint.root,
        merkle_index: data.checkpoint.index,
        validator_signatures: vec![EcdsaSignature::from_bytes(&data.signatures[0]).unwrap()],
    }
    .to_vec();
    let first = try_verify(program_id, &mut banks_client, &payer, recent_blockhash, insufficient, data.message.to_vec()).await;
    assert!(first.is_err(), "the underfunded first attempt must genuinely fail before recovery is meaningful");

    // Recovery: a fresh call, same domain config, now with a real
    // sufficient pair of signatures (0 and 2 — a different pair than
    // scenario 1's 0-and-1, showing recovery isn't tied to one specific
    // signer combination, only to meeting the threshold).
    let sufficient = MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: data.checkpoint.merkle_tree_hook_address,
        merkle_root: data.checkpoint.root,
        merkle_index: data.checkpoint.index,
        validator_signatures: vec![
            EcdsaSignature::from_bytes(&data.signatures[0]).unwrap(),
            EcdsaSignature::from_bytes(&data.signatures[2]).unwrap(),
        ],
    }
    .to_vec();
    let logs = try_verify(program_id, &mut banks_client, &payer, recent_blockhash, sufficient, data.message.to_vec())
        .await
        .expect("recovery with a sufficient real signature pair must succeed");
    assert_eq!(logs.last().unwrap(), &format!("Program {} success", program_id));
}

fn custom_error_code(err: &TransactionError) -> Option<u32> {
    if let TransactionError::InstructionError(_, solana_sdk::instruction::InstructionError::Custom(code)) = err {
        Some(*code)
    } else {
        None
    }
}

fn assert_custom_error(err: &TransactionError, expected: u32) {
    assert_eq!(custom_error_code(err), Some(expected), "expected custom error {expected}, got {err:?}");
}
