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
// SCOPE NOTE (see AuditAnchor.sol's own comment too): signs with
// AUDIT_ANCHOR_PRIVATE_KEY, a key DEDICATED to this one purpose — not
// HYPERLANE_RELAY_PRIVATE_KEY, which a re-audit correctly flagged as
// reusing the dispatch key here would mean "the same compromise that
// lets an attacker forge a settlement also lets them rewrite the
// external audit checkpoint that's supposed to catch it." A distinct
// key at least means those two compromises are independent events, even
// though both still ultimately live on the same backend under Anchor's
// current single-operator trust model — see
// docs/multisig-attestor-setup.md for the same caveat applied to the
// attestor keys, which applies here too until this key is also moved to
// separate custody. Falls back to HYPERLANE_RELAY_PRIVATE_KEY only if
// AUDIT_ANCHOR_PRIVATE_KEY isn't set, so existing deployments don't
// silently stop anchoring on upgrade.

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
  const privateKey = process.env.AUDIT_ANCHOR_PRIVATE_KEY || process.env.HYPERLANE_RELAY_PRIVATE_KEY;
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

// How stale the most recent anchor across ALL organizations is allowed
// to get before the sweep raises a loud, visible alarm instead of just
// a log line — the sweep runs every 30 minutes (see worker.ts), so 3
// hours means at least ~5 consecutive sweep failures, which rules out a
// single transient RPC blip and points at something actually wrong
// (out of gas, revoked key, misconfigured contract address, or the
// worker process itself being down).
const MISSED_ANCHOR_ALERT_THRESHOLD_MS = 3 * 60 * 60 * 1000;

/**
 * Raises a loud, hard-to-miss signal (not just a log line a re-audit
 * correctly pointed out is easy to silently ignore) when the sweep has
 * gone unusually long without successfully anchoring ANY organization —
 * checked against the most recent lastAnchoredAt across all orgs, since
 * a single org's timestamp could legitimately be old if that org simply
 * has no new audit activity to anchor. Best-effort: failing to send the
 * alert itself must never block or fail the sweep it's monitoring.
 */
async function checkForMissedAnchors(): Promise<void> {
  const mostRecent = await prisma.organization.findFirst({
    where: { lastAnchoredAt: { not: null } },
    orderBy: { lastAnchoredAt: "desc" },
    select: { lastAnchoredAt: true },
  });
  // No organization has ever anchored yet — nothing to compare a
  // staleness threshold against; anchorAuditChains()'s own "config not
  // set" log already covers the "never configured" case.
  if (!mostRecent?.lastAnchoredAt) return;

  const ageMs = Date.now() - mostRecent.lastAnchoredAt.getTime();
  if (ageMs < MISSED_ANCHOR_ALERT_THRESHOLD_MS) return;

  const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1);
  // eslint-disable-next-line no-console
  console.error(
    `AUDIT-ANCHOR ALERT: no organization has been successfully anchored in ${ageHours}h ` +
      `(threshold ${MISSED_ANCHOR_ALERT_THRESHOLD_MS / (60 * 60 * 1000)}h) — the external audit ` +
      `checkpoint is stale. Check AUDIT_ANCHOR_PRIVATE_KEY's balance/validity, ` +
      `AUDIT_ANCHOR_CONTRACT_ADDRESS, and HYPERLANE_RELAY_RPC_URL on anc-hor-worker.`
  );
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
  try {
    await checkForMissedAnchors();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("audit-anchor: missed-anchor check itself failed:", err instanceof Error ? err.message : err);
  }

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
