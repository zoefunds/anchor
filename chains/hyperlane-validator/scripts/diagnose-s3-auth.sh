#!/usr/bin/env bash
# Read-only S3 authorization diagnosis for the Hyperlane validator's
# checkpoint bucket, using the SAME credential currently installed on
# the Fly validator apps. Run this LOCALLY with that credential loaded
# into your own AWS CLI environment (never paste it into chat/Claude).
#
# Usage:
#   export AWS_ACCESS_KEY_ID=...      # same value you set on Fly
#   export AWS_SECRET_ACCESS_KEY=...  # same value you set on Fly
#   ./diagnose-s3-auth.sh
#   unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
#
# Nothing here prints a credential value. Paste the output back —
# it's all ARNs, region names, HTTP status codes, and AWS request IDs,
# none of it sensitive.

set -uo pipefail

BUCKET="anchor-hyperlane-validator-checkpoints"
REGION="eu-north-1"
PREFIX="validator1"
DIAG_KEY="${PREFIX}/_diag_test_$(date +%s).json"

echo "=== 1. Effective identity (sts:GetCallerIdentity) ==="
aws sts get-caller-identity --output json

echo
echo "=== 2. Actual bucket region ==="
aws s3api get-bucket-location --bucket "$BUCKET" --output json
aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>&1

echo
echo "=== 3. ListBucket limited to validator1/ prefix ==="
aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/" --region "$REGION" --max-items 20 2>&1

echo
echo "=== 4a. PutObject — disposable diagnostic object ==="
echo '{"diagnostic": true}' > /tmp/_diag_test.json
aws s3api put-object --bucket "$BUCKET" --key "$DIAG_KEY" --body /tmp/_diag_test.json --region "$REGION" 2>&1

echo
echo "=== 4b. HeadObject on the diagnostic object ==="
aws s3api head-object --bucket "$BUCKET" --key "$DIAG_KEY" --region "$REGION" 2>&1

echo
echo "=== 4c. GetObject on the diagnostic object ==="
aws s3api get-object --bucket "$BUCKET" --key "$DIAG_KEY" --region "$REGION" /tmp/_diag_test_download.json 2>&1
cat /tmp/_diag_test_download.json 2>&1

echo
echo "=== 4d. Cleanup — DeleteObject ==="
aws s3api delete-object --bucket "$BUCKET" --key "$DIAG_KEY" --region "$REGION" 2>&1
rm -f /tmp/_diag_test.json /tmp/_diag_test_download.json

echo
echo "=== 5. The actual object the validator itself needs (real failing case) ==="
aws s3api head-object --bucket "$BUCKET" --key "$PREFIX/checkpoint_latest_index.json" --region "$REGION" 2>&1

echo
echo "=== Done. Paste all output above back — none of it is a credential value. ==="
