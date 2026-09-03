#!/bin/bash
# Item D — V1 -> V2 Escrow cutover readiness check. Read-only, no
# mutations, safe to run at any time (including repeatedly, right up
# to the moment of an actual cutover — see docs/v1-v2-escrow-cutover.md,
# whose PASS criteria this script exists to prove, not assert).
#
# It answers exactly one question with on-chain-authoritative evidence,
# never DB-alone: "does the current V1 Escrow contract have ANY deposit
# that is DEPOSITED but not yet SETTLED?" It does this by scanning
# EVERY real Deposited event ever emitted by the V1 contract (not just
# the ones this app's own CaseSettlement rows happen to know about —
# the DB record for the one deposit this project has ever made was
# itself found stale earlier this session, see the incident log's
# "Verified, not just claimed" section) and checking each one's current
# deposits() status directly.
#
# Usage:
#   V1_ESCROW_ADDRESS=0x... V1_ESCROW_DEPLOY_BLOCK=11600000 \
#     ./scripts/cutover-readiness-check.sh
#
# Defaults below match this project's actual, currently-deployed V1
# Escrow (see incidents/2026-09-03-settlement-availability.md).

set -euo pipefail
cd "$(dirname "$0")/../chains/evm"

RPC_URL="${RPC_URL:-https://ethereum-sepolia.publicnode.com}"
V1_ESCROW_ADDRESS="${V1_ESCROW_ADDRESS:-0x5314725C32b58d0e1CACa510d491c8492D0BE997}"
DECISION_RELAY_ADDRESS="${DECISION_RELAY_ADDRESS:-0x94f3FF552CC879a36B19b829af3325Ea72cbC71C}"
SAFE_ADDRESS="${SAFE_ADDRESS:-0xc200534F7DEbF2816C085C5A156aBd686fA19f4C}"
# Conservative default: well before this project's first real Escrow
# interaction (block 11627209 per the incident log). Override if the
# real V1 deploy block is known more precisely, to speed the scan up.
V1_ESCROW_DEPLOY_BLOCK="${V1_ESCROW_DEPLOY_BLOCK:-11600000}"
CHUNK_SIZE=9000 # under most public RPCs' per-call eth_getLogs block-range cap

echo "=== Item D cutover readiness check ==="
echo "RPC:              $RPC_URL"
echo "V1 Escrow:        $V1_ESCROW_ADDRESS"
echo "DecisionRelay:    $DECISION_RELAY_ADDRESS"
echo "Safe:             $SAFE_ADDRESS"
echo ""

FAIL=0

# --- 1. Scan every Deposited event on V1 Escrow, re-check each escrowId's live status ---
echo "--- Scanning Deposited events on V1 Escrow (this can take a while) ---"
LATEST_BLOCK=$(cast block-number --rpc-url "$RPC_URL")
FROM=$V1_ESCROW_DEPLOY_BLOCK
ESCROW_IDS_FILE=$(mktemp)
while [ "$FROM" -le "$LATEST_BLOCK" ]; do
  TO=$((FROM + CHUNK_SIZE))
  if [ "$TO" -gt "$LATEST_BLOCK" ]; then TO=$LATEST_BLOCK; fi
  cast logs --address "$V1_ESCROW_ADDRESS" \
    "Deposited(bytes32,bytes32,address,address,address,uint256)" \
    --from-block "$FROM" --to-block "$TO" --rpc-url "$RPC_URL" --json 2>/dev/null \
    | jq -r '.[].topics[2]' >> "$ESCROW_IDS_FILE" || true
  FROM=$((TO + 1))
done

# Dedup — plain word-splitting is safe here: every entry is a
# 0x-prefixed 32-byte hex string with no spaces/globs, and mapfile
# isn't available on macOS's default bash 3.2.
# shellcheck disable=SC2207
UNIQUE_IDS=($(sort -u "$ESCROW_IDS_FILE"))
rm -f "$ESCROW_IDS_FILE"
echo "Found ${#UNIQUE_IDS[@]} unique escrowId(s) with a Deposited event on V1."
echo ""

UNSETTLED=0
UNDECODABLE=0
# V1's own deposits() ABI has FOUR outputs (status, claimant, respondent,
# amount) — no caseId field. That's V2-only (see chains/evm/contracts/
# Escrow.sol's Deposit struct). A cutover-readiness script that used the
# wrong ABI here would have silently failed to decode every call and
# (worse) would have then falsely reported PASS on an uninterpretable
# "?" status — this treats a decode failure as a hard stop, never as a
# silent pass.
for id in "${UNIQUE_IDS[@]}"; do
  if ! STATUS=$(cast call "$V1_ESCROW_ADDRESS" "deposits(bytes32)(uint8,address,address,uint256)" "$id" --rpc-url "$RPC_URL" 2>&1 | head -1); then
    echo "  escrowId $id -> ERROR calling deposits(): $STATUS"
    UNDECODABLE=$((UNDECODABLE + 1))
    continue
  fi
  echo "  escrowId $id -> status=$STATUS (0=NONE 1=DEPOSITED 2=SETTLED)"
  if [ "$STATUS" = "1" ]; then
    UNSETTLED=$((UNSETTLED + 1))
  elif [ "$STATUS" != "0" ] && [ "$STATUS" != "2" ]; then
    echo "    UNRECOGNIZED status value — treating as not-ready, not as settled"
    UNDECODABLE=$((UNDECODABLE + 1))
  fi
done

if [ "$UNDECODABLE" -gt 0 ]; then
  echo ""
  echo "FAIL: $UNDECODABLE escrowId(s) could not be read/decoded — cutover readiness cannot be confirmed, do not treat as PASS."
  FAIL=1
fi

if [ "$UNSETTLED" -gt 0 ]; then
  echo ""
  echo "FAIL: $UNSETTLED unsettled V1 deposit(s) found on-chain. Cutover must NOT proceed until every one is settled or refunded."
  FAIL=1
else
  echo ""
  echo "PASS: zero unsettled V1 deposits found on-chain (of ${#UNIQUE_IDS[@]} ever deposited)."
fi
echo ""

# --- 2. Safe governance readiness (owners/threshold match what the runbook expects) ---
echo "--- Safe governance readiness ---"
THRESHOLD=$(cast call "$SAFE_ADDRESS" "getThreshold()(uint256)" --rpc-url "$RPC_URL" 2>&1 || echo "?")
echo "  Safe threshold: $THRESHOLD (expected: 2)"
if [ "$THRESHOLD" != "2" ]; then
  echo "FAIL: Safe threshold is not 2 — governance no longer matches the documented 2-of-2 assumption."
  FAIL=1
fi
echo ""

# --- 3. Current settlementTarget for the Sepolia domain ---
echo "--- Current DecisionRelay.settlementTarget(11155111) ---"
CURRENT_TARGET=$(cast call "$DECISION_RELAY_ADDRESS" "settlementTarget(uint32)(address)" 11155111 --rpc-url "$RPC_URL" 2>&1 || echo "?")
echo "  $CURRENT_TARGET"
echo ""

echo "=== Summary ==="
if [ "$FAIL" -eq 0 ]; then
  echo "READY: no blocking condition found. This does NOT authorize a cutover by itself —"
  echo "see docs/v1-v2-escrow-cutover.md for the full checklist (fresh explicit authorization,"
  echo "SETTLEMENT_PAUSED discipline, ABI/deploy coupling, rehearsal) before acting on this."
  exit 0
else
  echo "NOT READY: see FAIL line(s) above."
  exit 1
fi
