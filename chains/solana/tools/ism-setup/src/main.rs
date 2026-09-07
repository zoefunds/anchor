//! One-off operator tool: initializes a real
//! hyperlane-sealevel-multisig-ism-message-id instance on Solana Testnet
//! and configures it with the sepolia domain's validator set/threshold —
//! step 1 of chains/solana/ISM_MIGRATION.md's Testnet proof. Uses the
//! crate's own typed instruction builders, not a hand-rolled encoder.
//!
//! Talks to the RPC directly (no solana-client/solana-sdk — see
//! Cargo.toml's comment for why) and signs the compiled legacy Message
//! itself via ed25519-dalek. Only ever builds a single-signer (payer)
//! transaction, so the "how many signatures" shortvec prefix is always
//! the one byte 0x01 — no general varint encoder needed.
//!
//! Run: cargo run --release -p ism-setup -- <payer-keypair-path> init
//!      cargo run --release -p ism-setup -- <payer-keypair-path> set-validators

use ed25519_dalek::{Signer, SigningKey};
use hyperlane_core::H160;
use hyperlane_sealevel_multisig_ism_message_id::instruction::{
    init_instruction, set_validators_and_threshold_instruction, ValidatorsAndThreshold,
};
use solana_hash::Hash;
use solana_message::Message;
use solana_program::pubkey::Pubkey;
use std::str::FromStr;

const RPC_URL: &str = "https://api.testnet.solana.com";
const SEPOLIA_DOMAIN: u32 = 11155111;
// Our own deployed instance (NOT Hyperlane's shared testnet program,
// which is already owned/initialized by Hyperlane's own team — see git
// history of this file for the AlreadyInitialized finding that caused
// this switch). Deploy tx:
// 67NDAobXbu9tszPyV7D9gnij42BdMYq9NSFnvjFQsts6dWCjSKBd37hQ51DNyafUNjYSYkYtWXtJzVt4cVgQpJgn
const MULTISIG_ISM_PROGRAM: &str = "5DLNSFtzEJBTipvvSvNPzvAFpx8uwf96qEjygAwT6ncY";

// Must match the LIVE EVM DecisionRelay ISM's real, current validator
// set exactly — read directly on-chain via validatorsAndThreshold(),
// NOT from docs/self-hosted-validator-setup.md's prose, which still
// describes the pre-2026-09-06 2-validator state. chains/hyperlane-validator/
// deployment.json is the authoritative record: validator2 was replaced
// (0x0eD86FBF8cb56622BB3094FeCde2872018e0f4B3 -> 0xf171c23607b892797Eb5eb4e52fc668f924Df0A3)
// for real operator independence, and a real validator3 was added.
// Confirmed live via `cast call` against 0xd916b90858B8bF7Cc7E111D3C7923ab4Fe0FCcf0
// on 2026-09-07: returns exactly these 3 addresses, threshold 2.
const VALIDATOR1: &str = "2ffFd80d446835214EF87Eb3753B48935550f73f";
const VALIDATOR2: &str = "f171c23607b892797Eb5eb4e52fc668f924Df0A3";
const VALIDATOR3: &str = "4dbc8704ebD282535d64Be6daDF2a477C543114D";
const THRESHOLD: u8 = 2;

/// Loads a raw Solana CLI-format keypair file (JSON array of 64 bytes:
/// 32-byte seed + 32-byte pubkey) — same format/parsing this session
/// already verified correct for attested_settle's own signing.
fn load_signing_key(path: &str) -> (SigningKey, Pubkey) {
    let raw = std::fs::read_to_string(path).expect("read keypair file");
    let bytes: Vec<u8> = raw
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().parse::<u8>().expect("bad keypair byte"))
        .collect();
    assert_eq!(bytes.len(), 64, "expected a 64-byte Solana CLI keypair file");
    let seed: [u8; 32] = bytes[0..32].try_into().unwrap();
    let signing_key = SigningKey::from_bytes(&seed);
    let pubkey = Pubkey::new_from_array(signing_key.verifying_key().to_bytes());
    (signing_key, pubkey)
}

fn rpc_call(method: &str, params: serde_json::Value) -> serde_json::Value {
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let response: serde_json::Value = ureq::post(RPC_URL)
        .send_json(&body)
        .expect("rpc request failed")
        .into_json()
        .expect("rpc response not json");
    if let Some(err) = response.get("error") {
        panic!("RPC error calling {method}: {err}");
    }
    response["result"].clone()
}

fn get_latest_blockhash() -> Hash {
    let result = rpc_call("getLatestBlockhash", serde_json::json!([{"commitment": "confirmed"}]));
    let blockhash_str = result["value"]["blockhash"].as_str().expect("no blockhash in response");
    Hash::from_str(blockhash_str).expect("bad blockhash")
}

/// Builds and submits a single-instruction, single-signer (payer)
/// legacy transaction. Legacy wire format: shortvec signature count
/// (always the single byte 0x01 here) + one 64-byte signature +
/// bincode-serialized Message — confirmed against solana-program's own
/// Message/Transaction serialization convention, not guessed.
fn submit(signing_key: &SigningKey, payer: Pubkey, instruction: solana_program::instruction::Instruction) -> String {
    let blockhash = get_latest_blockhash();
    let message = Message::new_with_blockhash(&[instruction], Some(&payer), &blockhash);
    let message_bytes = bincode::serialize(&message).expect("serialize message");
    let signature = signing_key.sign(&message_bytes);

    let mut tx_bytes = vec![1u8]; // shortvec: 1 signature
    tx_bytes.extend_from_slice(&signature.to_bytes());
    tx_bytes.extend_from_slice(&message_bytes);

    let encoded = base64_encode(&tx_bytes);
    let result = rpc_call(
        "sendTransaction",
        serde_json::json!([encoded, {"encoding": "base64", "preflightCommitment": "confirmed"}]),
    );
    result.as_str().expect("sendTransaction did not return a signature").to_string()
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(ALPHABET[(n >> 18 & 0x3F) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6 & 0x3F) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(n & 0x3F) as usize] as char } else { '=' });
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let keypair_path = args.get(1).expect("usage: ism-setup <payer-keypair-path> <init|set-validators>");
    let cmd = args.get(2).expect("usage: ism-setup <payer-keypair-path> <init|set-validators>");
    let (signing_key, payer) = load_signing_key(keypair_path);

    let program_id = Pubkey::from_str(MULTISIG_ISM_PROGRAM).expect("bad program id");

    println!("payer: {payer}");
    println!("multisig-ism-message-id program: {program_id}");

    match cmd.as_str() {
        "init" => {
            println!("\nInitialize");
            let ix = init_instruction(program_id, payer).expect("build init instruction");
            let sig = submit(&signing_key, payer, ix);
            println!("  submitted, signature: {sig}");
        }
        "set-validators" => {
            println!("\nSetValidatorsAndThreshold (domain={SEPOLIA_DOMAIN}, threshold={THRESHOLD})");
            let validators_and_threshold = ValidatorsAndThreshold {
                validators: vec![
                    H160::from_str(VALIDATOR1).expect("bad validator1 address"),
                    H160::from_str(VALIDATOR2).expect("bad validator2 address"),
                    H160::from_str(VALIDATOR3).expect("bad validator3 address"),
                ],
                threshold: THRESHOLD,
            };
            validators_and_threshold.validate().expect("validator set failed validation");
            let ix = set_validators_and_threshold_instruction(program_id, payer, SEPOLIA_DOMAIN, validators_and_threshold)
                .expect("build set-validators instruction");
            let sig = submit(&signing_key, payer, ix);
            println!("  submitted, signature: {sig}");
        }
        other => panic!("unknown command {other}, expected init or set-validators"),
    }

    println!("\nCheck the signature above on https://explorer.solana.com/tx/<sig>?cluster=testnet before proceeding.");
}
