import { createHash } from "crypto";
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { prisma } from "@/lib/prisma";

// Periodically posts each organization's current audit-log hash-chain
// head to a small Sepolia contract (chains/evm/contracts/AuditAnchor.sol)
// — the external checkpoint a re-audit asked for. The in-database chain
// (lib/audit.ts) detects an in-place edit of one historical row, but
// someone with direct database write access can rewrite the WHOLE chain
// consistently and the database alone would show nothing wrong. A
// periodically-posted external record closes that: undetectably
// rewriting history now also requires rewriting this contract's own
// history, which a public chain doesn't allow.
//
// SCOPE NOTE (see AuditAnchor.sol's own comment too): this reuses
// HYPERLANE_RELAY_PRIVATE_KEY for pragmatism (already funded, already
// used for other infra), not a dedicated key — under Anchor's current
// single-operator trust model that means this doesn't defend against a
// fully malicious operator who controls both the database and this key.
// What it DOES add: detection of accidental/bug-caused database
// corruption, detection of a compromised database that doesn't also
// compromise this specific key, and a genuinely independent, publicly-
// checkable timestamped record any external auditor can verify without
// trusting Anchor's own database at all.

const ANCHOR_ABI = [
  {
    type: "function",
    name: "anchor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orgIdHash", type: "bytes32" },
      { name: "auditHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

function getAuditAnchorConfig() {
  const contractAddress = process.env.AUDIT_ANCHOR_CONTRACT_ADDRESS;
  const privateKey = process.env.HYPERLANE_RELAY_PRIVATE_KEY;
  const rpcUrl = process.env.HYPERLANE_RELAY_RPC_URL;
  if (!contractAddress || !privateKey) {
    return null; // anchoring is optional infra — a missing config skips the sweep rather than crashing it
  }
  return {
    contractAddress: contractAddress as Address,
    privateKey: (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex,
    rpcUrl,
  };
}

/** keccak256 of the organization id string — matches AuditAnchor.sol's own comment on why it never needs to know what an org actually is. */
function orgIdHash(organizationId: string): Hex {
  return keccak256(toHex(organizationId));
}

/**
 * Sweeps every organization with at least one audit-log entry, posting a
 * fresh on-chain anchor only for those whose chain head has genuinely
 * changed since the last anchor (comparing against
 * Organization.lastAnchoredHash) — a sweep tick with nothing new to
 * anchor for an org costs no gas for that org. Returns the number of
 * organizations actually anchored this run.
 */
export async function anchorAuditChains(): Promise<number> {
  const config = getAuditAnchorConfig();
  if (!config) {
    // eslint-disable-next-line no-console
    console.log("audit-anchor: AUDIT_ANCHOR_CONTRACT_ADDRESS/HYPERLANE_RELAY_PRIVATE_KEY not set, skipping sweep");
    return 0;
  }

  const orgs = await prisma.organization.findMany({
    where: { auditLogs: { some: {} } },
    select: { id: true, lastAnchoredHash: true },
  });

  const account = privateKeyToAccount(config.privateKey);
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ chain: sepolia, transport, account });

  let anchoredCount = 0;
  for (const org of orgs) {
    const latest = await prisma.auditLog.findFirst({
      where: { organizationId: org.id },
      orderBy: { createdAt: "desc" },
      select: { hash: true },
    });
    if (!latest || latest.hash === org.lastAnchoredHash) continue;

    try {
      const auditHash = sha256HexToBytes32(latest.hash);
      const { request } = await publicClient.simulateContract({
        address: config.contractAddress,
        abi: ANCHOR_ABI,
        functionName: "anchor",
        args: [orgIdHash(org.id), auditHash],
        account,
      });
      const txHash = await walletClient.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      await prisma.organization.update({
        where: { id: org.id },
        data: { lastAnchoredHash: latest.hash, lastAnchoredAt: new Date(), lastAnchorTxHash: txHash },
      });
      anchoredCount++;
    } catch (err) {
      // One organization's anchor failing (a transient RPC issue, low
      // gas balance, etc.) shouldn't stop the sweep from anchoring
      // everyone else — it'll retry this org again on the next sweep,
      // since lastAnchoredHash wasn't updated.
      // eslint-disable-next-line no-console
      console.error(`audit-anchor: failed to anchor organization ${org.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return anchoredCount;
}

/** AuditLog.hash is a sha256 hex digest (64 hex chars) OR one of the pre-migration "legacy-unchained:<id>" sentinels (see the migration's own comment) — the latter isn't a real hash and has no fixed byte length, so it's hashed again (this time with a real, fixed-size digest) rather than passed through, keeping this function's output always a valid bytes32 regardless of which kind of value it's given. */
function sha256HexToBytes32(hash: string): Hex {
  if (/^[0-9a-fA-F]{64}$/.test(hash)) {
    return `0x${hash}` as Hex;
  }
  return `0x${createHash("sha256").update(hash).digest("hex")}` as Hex;
}
