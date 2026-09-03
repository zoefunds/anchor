#!/bin/bash
# Phase A evidence monitor — read-only, no mutations. Appends one
# timestamped snapshot per run to incidents/2026-09-03-settlement-availability.md.
cd "$(dirname "$0")/../chains/evm" || exit 1

fetch() {
  for i in 1 2 3; do
    result=$(curl -s -m 10 "$1" 2>&1)
    if [ -n "$result" ]; then echo "$result"; return; fi
    sleep 1
  done
  echo "unreachable(retried)"
}

fetch_code() {
  for i in 1 2 3; do
    result=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$1" 2>&1)
    if [ "$result" != "000" ]; then echo "$result"; return; fi
    sleep 1
  done
  echo "000(retried)"
}

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
V1_IDX=$(fetch "https://anchor-hyperlane-validator-checkpoints.s3.eu-north-1.amazonaws.com/validator1/checkpoint_latest_index.json")
V2_IDX=$(fetch "https://anchor-hyperlane-validator-checkpoints.s3.eu-north-1.amazonaws.com/validator2/checkpoint_latest_index.json")
V1_MSG=$(fetch_code "https://anchor-hyperlane-validator-checkpoints.s3.eu-north-1.amazonaws.com/validator1/checkpoint_873170_with_id.json")
V2_MSG=$(fetch_code "https://anchor-hyperlane-validator-checkpoints.s3.eu-north-1.amazonaws.com/validator2/checkpoint_873170_with_id.json")
DEPOSIT=$(cast call 0x5314725C32b58d0e1CACa510d491c8492D0BE997 "deposits(bytes32)(uint8,address,address,uint256)" 0x4d0659d574bf2fc71ab4cdab58307df787007a45d084282e267b8475cf44ed17 --rpc-url https://ethereum-sepolia.publicnode.com 2>&1 | head -1)
DELIVERED=$(cast call 0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766 "delivered(bytes32)(bool)" 0xf8923e064e5eed132ecb05fdb5de08eac060cb69b0ad22345d7ba398a41d3692 --rpc-url https://ethereum-sepolia.publicnode.com 2>&1)
PROCESSED=$(cast call 0x94f3FF552CC879a36B19b829af3325Ea72cbC71C "processedDecisions(bytes32)(bool)" 0x7d1e5e63d51a3f1c49626c2c4edbf48bb5a874b025c274b0d79dc3922462a24c --rpc-url https://ethereum-sepolia.publicnode.com 2>&1)

{
  echo ""
  echo "### $TS"
  echo "- validator1 latest_index: $V1_IDX | validator2 latest_index: $V2_IDX"
  echo "- checkpoint_873170_with_id.json: validator1=$V1_MSG validator2=$V2_MSG"
  echo "- Escrow deposit status (1=DEPOSITED,2=SETTLED): $DEPOSIT"
  echo "- Mailbox.delivered(messageId): $DELIVERED"
  echo "- DecisionRelay.processedDecisions(decisionHash): $PROCESSED"
} >> ../../incidents/2026-09-03-settlement-availability.md

if echo "$DEPOSIT" | grep -q "^2$"; then
  echo "SETTLED_DETECTED"
fi
