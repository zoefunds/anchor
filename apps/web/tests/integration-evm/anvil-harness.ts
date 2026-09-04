import { spawn, type ChildProcess } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

// Real Anvil integration harness — Priority 1 of the settlement-
// readiness gaps. No mocked contract reads anywhere in this suite:
// every ABI call here decodes a REAL response from a REAL deployed
// contract's REAL bytecode on a real (local, ephemeral) EVM. This is
// exactly the class of test that would have caught the deposits()
// ABI-shape bug (5-output ABI decoding a real 4-output V1 contract)
// before it ever reached production — the mocked unit tests couldn't,
// because a mock returns whatever shape you tell it to, regardless of
// whether that shape matches any real contract.

const EVM_DIR = join(__dirname, "../../../../chains/evm");
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8555);
export const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Anvil's own default dev mnemonic ("test test test ... junk") —
// deterministically derives the exact same 10 pre-funded accounts
// anvil itself starts with, standard index 0-9. Deriving from the
// mnemonic (rather than hand-typing 32-byte hex private keys from
// memory, which turned out extremely error-prone the first time this
// file was written — 6 of 10 hardcoded keys were malformed) is the
// only reliable way to get this right.
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
export const DEV_PRIVATE_KEYS: Hex[] = Array.from({ length: 10 }, (_, i) => {
  const privateKeyBytes = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: i }).getHdKey().privateKey;
  if (!privateKeyBytes) throw new Error(`no private key derived for dev account index ${i}`);
  return `0x${Buffer.from(privateKeyBytes).toString("hex")}` as Hex;
});

function loadArtifact(pathFromOut: string): { abi: unknown[]; bytecode: Hex; deployedBytecode: Hex } {
  const json = JSON.parse(readFileSync(join(EVM_DIR, "out", pathFromOut), "utf8"));
  // bytecode = CREATE-time bytecode (constructor + init logic) — only
  // valid as the `data` of a deployment transaction. deployedBytecode =
  // the real RUNTIME code that ends up living at the contract's
  // address. A real bug found writing the worker-queue Anvil test:
  // using `bytecode` with anvil's setCode (to plant a contract at a
  // fixed address without a real deploy tx) silently "worked" — the
  // call didn't revert — but returned garbage from every function,
  // since CREATE-time bytecode is not runtime-executable code at all.
  return { abi: json.abi, bytecode: json.bytecode.object as Hex, deployedBytecode: json.deployedBytecode.object as Hex };
}

export const ARTIFACTS = {
  escrowV1: loadArtifact("EscrowV1.sol/EscrowV1.json"),
  escrowV2: loadArtifact("Escrow.sol/Escrow.json"),
  decisionRelay: loadArtifact("DecisionRelay.sol/DecisionRelay.json"),
  fakeMailbox: loadArtifact("DecisionRelay.t.sol/FakeMailbox.json"),
  revertingSettlementTarget: loadArtifact("DecisionRelay.t.sol/RevertingSettlementTarget.json"),
};

let anvilProcess: ChildProcess | null = null;

/** Starts a real, ephemeral Anvil node for this test file. One instance per test FILE (not per test) — deployments are cheap, chain state resets via snapshot/revert between tests instead of a fresh process each time. */
export async function startAnvil(): Promise<void> {
  anvilProcess = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  // Wait for the RPC to actually accept connections rather than a fixed
  // sleep — anvil's startup time varies with machine load.
  const client = createPublicClient({ chain: foundry, transport: http(ANVIL_RPC_URL) });
  for (let i = 0; i < 50; i++) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not become ready in time");
}

export function stopAnvil(): void {
  anvilProcess?.kill();
  anvilProcess = null;
}

export function getTestClient() {
  return createTestClient({ chain: foundry, mode: "anvil", transport: http(ANVIL_RPC_URL) });
}

export function getPublicClient() {
  return createPublicClient({ chain: foundry, transport: http(ANVIL_RPC_URL) });
}

export function getWalletClient(privateKey: Hex) {
  return createWalletClient({ account: privateKeyToAccount(privateKey), chain: foundry, transport: http(ANVIL_RPC_URL) });
}

/** Deploys a contract from a loaded artifact and returns its real, live address — waits for the real deployment receipt, not just the tx hash. */
export async function deploy(
  deployer: Hex,
  artifact: { abi: unknown[]; bytecode: Hex },
  args: unknown[] = [],
  value?: bigint
): Promise<Address> {
  const wallet = getWalletClient(deployer);
  const publicClient = getPublicClient();
  const hash = await wallet.deployContract({ abi: artifact.abi as never, bytecode: artifact.bytecode, args, value });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deployment produced no contract address");
  return receipt.contractAddress;
}
