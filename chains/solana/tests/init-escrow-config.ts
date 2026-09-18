import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";

async function main() {
  process.env.ANCHOR_PROVIDER_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  process.env.ANCHOR_WALLET = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const idl = JSON.parse(readFileSync(new URL("../target/idl/escrow.json", import.meta.url), "utf-8"));
  const program = new (anchor as any).Program(idl, provider);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const existing = await provider.connection.getAccountInfo(configPda);
  if (existing) {
    console.log("config already exists at", configPda.toBase58());
    return;
  }
  const sig = await program.methods
    .initializeConfig()
    .accounts({ authority: provider.wallet.publicKey, config: configPda, systemProgram: anchor.web3.SystemProgram.programId })
    .rpc();
  console.log("initialized config", configPda.toBase58(), "tx", sig);
}
main().catch((e) => { console.error(e); process.exit(1); });
