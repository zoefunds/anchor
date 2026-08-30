// Initializes a freshly-deployed hyperlane-sealevel-composite-ism program
// with a single root node: IsmNode::TrustedRelayer { relayer }. This is the
// Sealevel-side equivalent of chains/evm/contracts/TrustedRelayerIsm.sol —
// verify() (here, the Verify instruction) accepts iff our own relayer key
// signed, which is sound only because Anchor is both the sole dispatcher
// and sole relayer for this route (same tradeoff, same justification as
// the EVM-side contract's doc comment).
//
// Wire format verified directly against the pinned Hyperlane monorepo
// source, not guessed:
//   - Instruction discriminator: account-utils's PROGRAM_INSTRUCTION_DISCRIMINATOR
//     ([1,1,1,1,1,1,1,1]), from libraries/account-utils/src/discriminator.rs.
//   - Instruction enum order (Initialize=0, UpdateConfig=1, GetOwner=2,
//     TransferOwnership=3, SetDomainIsm=4, RemoveDomainIsm=5, Pause=6,
//     Unpause=7) and IsmNode enum order (TrustedRelayer=0, ...), from
//     programs/ism/composite-ism/src/{instruction,accounts}.rs — Borsh
//     serializes an enum as a 1-byte variant index in declaration order.
//   - Storage PDA seeds: VERIFY_ACCOUNT_METAS_PDA_SEEDS =
//     [b"hyperlane_ism", b"-", b"verify", b"-", b"account_metas"], from
//     libraries/interchain-security-module-interface/src/lib.rs.
//   - Initialize's account list (payer, storage PDA, system program, BPF
//     upgradeable loader ProgramData PDA), from instruction.rs's
//     initialize_instruction().
//
// Run: npx tsx tests/init-composite-ism.ts <composite-ism-program-id> <relayer-pubkey>

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";

const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

async function main() {
  const programId = new PublicKey(process.argv[2]);
  const relayer = new PublicKey(process.argv[3]);
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL ?? "https://api.testnet.solana.com";
  const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;

  const connection = new Connection(rpcUrl, "confirmed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf-8"))));

  const [storagePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hyperlane_ism"), Buffer.from("-"), Buffer.from("verify"), Buffer.from("-"), Buffer.from("account_metas")],
    programId
  );
  const [programDataKey] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE);

  // Instruction::Initialize(IsmNode::TrustedRelayer { relayer })
  const data = Buffer.concat([
    Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]), // PROGRAM_INSTRUCTION_DISCRIMINATOR
    Buffer.from([0]), // Instruction::Initialize variant tag
    Buffer.from([0]), // IsmNode::TrustedRelayer variant tag
    relayer.toBuffer(),
  ]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: storagePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: programDataKey, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  console.log("composite-ism initialized");
  console.log("programId:", programId.toBase58());
  console.log("storagePda:", storagePda.toBase58());
  console.log("relayer (trusted):", relayer.toBase58());
  console.log("tx:", sig);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
