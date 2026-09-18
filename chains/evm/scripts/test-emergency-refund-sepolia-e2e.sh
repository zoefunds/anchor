#!/usr/bin/env bash
# Real end-to-end proof of the Sepolia emergency-refund path: deploys a
# throwaway 2-of-2 DecisionRelay + Escrow (never the production
# contracts — Escrow.decisionRelay is immutable, so this can't reuse the
# real deployed pair), deposits real Sepolia ETH, waits past a short
# timeout, submits a real 2-of-2 ECDSA-attested emergencyRefund call, and
# verifies the claimant's balance actually moves. Same contract bytecode
# as production (contracts/Escrow.sol, contracts/DecisionRelay.sol are
# unmodified) — only the attestor set and timeout are throwaway/short,
# exactly so this can prove the mechanism without needing the real
# production attestor keys (which live on Fly, not this machine) or
# waiting out a real 30-day/1-hour window.
#
# Usage: RELAY_PRIVATE_KEY=0x... ./scripts/test-emergency-refund-sepolia-e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${RELAY_PRIVATE_KEY:?set RELAY_PRIVATE_KEY to the deployer/depositAuthorizer/governance-owner key, e.g. apps/web/.env HYPERLANE_RELAY_PRIVATE_KEY}"
RPC_URL="${RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-60}"

DEPLOYER_ADDR=$(cast wallet address --private-key "$RELAY_PRIVATE_KEY")
echo "Deployer/depositAuthorizer/governance-owner: $DEPLOYER_ADDR"

echo
echo "1. Generating throwaway attestor + claimant keys (test-only, no real funds at risk beyond this run's own tiny deposit)"
ATTESTOR1=$(cast wallet new --json)
ATTESTOR1_PK=$(echo "$ATTESTOR1" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8'))[0].private_key)")
ATTESTOR1_ADDR=$(cast wallet address --private-key "$ATTESTOR1_PK")
ATTESTOR2=$(cast wallet new --json)
ATTESTOR2_PK=$(echo "$ATTESTOR2" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8'))[0].private_key)")
ATTESTOR2_ADDR=$(cast wallet address --private-key "$ATTESTOR2_PK")
CLAIMANT=$(cast wallet new --json)
CLAIMANT_PK=$(echo "$CLAIMANT" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8'))[0].private_key)")
CLAIMANT_ADDR=$(cast wallet address --private-key "$CLAIMANT_PK")
RESPONDENT_ADDR=$(cast wallet new --json | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8'))[0].address)")
echo "  attestor1: $ATTESTOR1_ADDR"
echo "  attestor2: $ATTESTOR2_ADDR"
echo "  claimant:  $CLAIMANT_ADDR"
echo "  respondent: $RESPONDENT_ADDR"

echo
echo "2. Deploying throwaway DecisionRelay (2-of-2, real Sepolia mailbox/ISM, unused for this direct-call test)"
RELAY_OUT=$(HYPERLANE_MAILBOX=0x345E7246631ceb0300427caB75eacA10c326BB09 \
  GOVERNANCE_OWNER="$DEPLOYER_ADDR" \
  ATTESTOR_ADDRESSES="$ATTESTOR1_ADDR,$ATTESTOR2_ADDR" \
  ATTESTOR_THRESHOLD=2 \
  CUSTOM_ISM=0xd916b90858B8bF7Cc7E111D3C7923ab4Fe0FCcf0 \
  forge script deploy/DeployDecisionRelay.s.sol --rpc-url "$RPC_URL" --broadcast --private-key "$RELAY_PRIVATE_KEY")
DECISION_RELAY_ADDR=$(echo "$RELAY_OUT" | grep "DecisionRelay deployed at:" | awk '{print $NF}')
echo "  DecisionRelay: $DECISION_RELAY_ADDR"

echo
echo "3. Deploying throwaway Escrow (decisionRelay = the throwaway relay above, timeout=${TIMEOUT_SECONDS}s)"
ESCROW_OUT=$(DECISION_RELAY_ADDRESS="$DECISION_RELAY_ADDR" \
  DEPOSIT_AUTHORIZER_ADDRESS="$DEPLOYER_ADDR" \
  EMERGENCY_REFUND_TIMEOUT_SECONDS="$TIMEOUT_SECONDS" \
  forge script deploy/DeployEscrow.s.sol --rpc-url "$RPC_URL" --broadcast --private-key "$RELAY_PRIVATE_KEY")
ESCROW_ADDR=$(echo "$ESCROW_OUT" | grep "Escrow deployed at:" | awk '{print $NF}')
echo "  Escrow: $ESCROW_ADDR"

CASE_ID=$(cast keccak "test-case-$(date +%s)")
ESCROW_ID=$(cast keccak "test-escrow-$(date +%s)")
AMOUNT_WEI=1000000000000000 # 0.001 ETH

echo
echo "4. Funding claimant, authorizing + making the real deposit"
cast send "$CLAIMANT_ADDR" --value 0.002ether --private-key "$RELAY_PRIVATE_KEY" --rpc-url "$RPC_URL" > /dev/null
cast send "$ESCROW_ADDR" "authorizeDeposit(bytes32,bytes32,address,address,uint256)" \
  "$CASE_ID" "$ESCROW_ID" "$CLAIMANT_ADDR" "$RESPONDENT_ADDR" "$AMOUNT_WEI" \
  --private-key "$RELAY_PRIVATE_KEY" --rpc-url "$RPC_URL" > /dev/null
cast send "$ESCROW_ADDR" "deposit(bytes32,bytes32,address,address)" \
  "$CASE_ID" "$ESCROW_ID" "$CLAIMANT_ADDR" "$RESPONDENT_ADDR" \
  --value "${AMOUNT_WEI}wei" --private-key "$CLAIMANT_PK" --rpc-url "$RPC_URL" > /dev/null
echo "  deposited ${AMOUNT_WEI} wei for caseId=$CASE_ID escrowId=$ESCROW_ID"

echo
echo "5. Confirming emergency_refund is correctly rejected before the timeout elapses"
PROOF_HASH=$(cast keccak "test-proof")
DIGEST=$(cast keccak "$(cast abi-encode 'f(string,address,address,bytes32,bytes32,bytes32)' 'ANCHOR_EMERGENCY_REFUND_V1' "$DECISION_RELAY_ADDR" "$ESCROW_ADDR" "$CASE_ID" "$ESCROW_ID" "$PROOF_HASH")")
sign_digest() {
  # Raw ECDSA sign over the digest bytes, NO EIP-191 prefix — matches
  # DecisionRelay.sol's _recoverSigner, which calls ecrecover(hash, v, r, s)
  # directly on the hash it's given, never toEthSignedMessageHash.
  node -e "
const { ethers } = require('ethers');
const sk = new ethers.SigningKey('$1');
process.stdout.write(sk.sign('$DIGEST').serialized);
"
}
SIG1=$(sign_digest "$ATTESTOR1_PK")
SIG2=$(sign_digest "$ATTESTOR2_PK")

set +e
PRETIMEOUT_OUT=$(cast send "$DECISION_RELAY_ADDR" "emergencyRefund(address,bytes32,bytes32,bytes32,bytes[])" \
  "$ESCROW_ADDR" "$CASE_ID" "$ESCROW_ID" "$PROOF_HASH" "[$SIG1,$SIG2]" \
  --private-key "$RELAY_PRIVATE_KEY" --rpc-url "$RPC_URL" 2>&1)
PRETIMEOUT_EXIT=$?
set -e
if [ "$PRETIMEOUT_EXIT" -ne 0 ]; then
  echo "  ok: rejected pre-timeout as expected (cast exited non-zero, i.e. reverted)"
else
  echo "  FAILED: pre-timeout call succeeded when it should have reverted with TimeoutNotElapsed — real bug, aborting"
  echo "$PRETIMEOUT_OUT"
  exit 1
fi

echo
echo "6. Waiting ${TIMEOUT_SECONDS}s for the timeout to elapse"
sleep "$((TIMEOUT_SECONDS + 5))"

echo
echo "7. Submitting the real 2-of-2 attested emergencyRefund"
CLAIMANT_BEFORE=$(cast balance "$CLAIMANT_ADDR" --rpc-url "$RPC_URL")
cast send "$DECISION_RELAY_ADDR" "emergencyRefund(address,bytes32,bytes32,bytes32,bytes[])" \
  "$ESCROW_ADDR" "$CASE_ID" "$ESCROW_ID" "$PROOF_HASH" "[$SIG1,$SIG2]" \
  --private-key "$RELAY_PRIVATE_KEY" --rpc-url "$RPC_URL"
CLAIMANT_AFTER=$(cast balance "$CLAIMANT_ADDR" --rpc-url "$RPC_URL")
DELTA=$((CLAIMANT_AFTER - CLAIMANT_BEFORE))
echo "  claimant balance delta: $DELTA wei (expected exactly $AMOUNT_WEI)"
if [ "$DELTA" != "$AMOUNT_WEI" ]; then
  echo "FAILED: unexpected balance delta"
  exit 1
fi

STATUS=$(cast call "$ESCROW_ADDR" "deposits(bytes32)(uint8,address,address,uint256,bytes32,uint256)" "$ESCROW_ID" --rpc-url "$RPC_URL" | head -1)
echo "  deposit status after refund: $STATUS (1=DEPOSITED, 2=SETTLED — emergencyRefund reuses SETTLED, see Escrow.sol's Status enum comment)"

echo
echo "All assertions passed — real deposit -> timeout -> 2-of-2 attested emergencyRefund proven end-to-end on Sepolia, against the unmodified production Escrow/DecisionRelay bytecode."
