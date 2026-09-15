import { type Address, type Hex, encodeAbiParameters, keccak256 } from "viem";

// Priority 5, item 19 — the real, shared encoding for
// DecisionRelay.emergencyRefund()'s signed attestation content. Kept
// as the ONE place this hash is computed (previously only duplicated
// inline in tests/integration-evm/settlement.evm.test.ts) so the app's
// "prepare a refund request" page can never quietly drift from what
// the real deployed contract actually checks.
//
// IMPORTANT, and explicitly flagged rather than silently assumed: this
// binds exactly what the CURRENT (Item E) contract binds — decisionRelay
// address, target escrow, caseId, escrowId, proofHash. It does NOT
// bind amount, chain/domain, or an expiry, which Priority 3 (item 10)
// asks for. Adding those requires a real contract change and
// redeploy, which is separate, larger work gated on its own
// authorization — this module intentionally matches today's real,
// deployed-shape contract, not an aspirational one.
export function emergencyRefundAttestationHash(params: {
  decisionRelayAddress: Address;
  settlementTargetAddress: Address;
  caseIdBytes32: Hex;
  escrowIdBytes32: Hex;
  proofHashBytes32: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [
        "ANCHOR_EMERGENCY_REFUND_V1",
        params.decisionRelayAddress,
        params.settlementTargetAddress,
        params.caseIdBytes32,
        params.escrowIdBytes32,
        params.proofHashBytes32,
      ]
    )
  );
}

/** EVM escrow case id encoding: UTF-8 bytes of the case id string, right-padded to bytes32. */
export function caseIdToBytes32(caseId: string): Hex {
  return `0x${Buffer.from(caseId).toString("hex").padEnd(64, "0")}` as Hex;
}
