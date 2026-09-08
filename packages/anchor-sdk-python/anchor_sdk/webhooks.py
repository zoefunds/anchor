import hashlib
import hmac
import time
import re
from typing import Optional

_SIGNATURE_RE = re.compile(r"^sha256=([0-9a-f]+)$")


def verify_webhook_signature(
    raw_body: str,
    timestamp_header: Optional[str],
    signature_header: Optional[str],
    secret: str,
    tolerance_seconds: int = 300,
) -> bool:
    """
    Verifies an inbound Anchor webhook delivery. Matches
    apps/web/src/lib/webhooks.ts's signPayload/deliverWebhookAttempt
    exactly: HMAC-SHA256 over `{timestamp}.{rawBody}` using the raw
    (decrypted) webhook secret, sent as headers `X-Anchor-Timestamp` and
    `X-Anchor-Signature: sha256=<hex>`.

    `raw_body` must be the exact bytes/string Anchor sent (before any
    json.loads/re-dump on the receiving end) — HMACs aren't stable
    across re-serialization.
    """
    if not timestamp_header or not signature_header:
        return False

    try:
        timestamp = float(timestamp_header)
    except ValueError:
        return False
    if abs(time.time() - timestamp) > tolerance_seconds:
        return False

    match = _SIGNATURE_RE.match(signature_header)
    if not match:
        return False
    provided_hex = match.group(1)

    expected_hex = hmac.new(secret.encode("utf-8"), f"{timestamp_header}.{raw_body}".encode("utf-8"), hashlib.sha256).hexdigest()

    try:
        expected = bytes.fromhex(expected_hex)
        provided = bytes.fromhex(provided_hex)
    except ValueError:
        return False

    return len(expected) == len(provided) and hmac.compare_digest(expected, provided)


# Fixed vocabulary from apps/web/src/lib/webhooks.ts's WEBHOOK_EVENTS —
# kept in sync by hand, same convention as packages/anchor-sdk's copy.
WEBHOOK_EVENTS = (
    "case.status_changed",
    "case.decided",
    "case.appealed",
    "case.relay_dispatched",
    "case.emergency_refund_prepared",
    "case.emergency_refund_settled",
)
