import { safeFetch, assertSafeToFetch } from "@/lib/ssrf-guard";

// Item F's "real alert delivery" half. Deliberately separate from
// lib/webhooks.ts's per-organization customer webhooks: this is a
// single, operator-configured destination for ANCHOR'S OWN ops team
// (a Slack incoming webhook URL is the expected shape, hence the
// Slack-compatible `{ text }` body — but anything that accepts a POST
// with a text field works), not something orgs configure or see. A
// finding with nowhere to send never vanishes silently — see
// lib/reconciliation.ts, which persists every finding to
// ReconciliationFinding regardless of whether this function's HTTP
// delivery succeeds, is configured at all, or throws.

export type AlertSeverity = "info" | "warning" | "critical";

export class OpsAlertDeliveryError extends Error {}

/**
 * Priority 5, item 20: a single OPS_ALERT_OWNER for every severity was
 * real, but wrong — a critical finding (funds genuinely at risk) and
 * an info-level resolution notice have no business paging the same
 * person on the same cadence. OPS_ALERT_OWNER_CRITICAL/WARNING/INFO
 * let each severity route to a different named person/team/on-call
 * rotation; OPS_ALERT_OWNER remains as the fallback used when a
 * severity-specific one isn't set, so a minimal single-operator
 * deployment doesn't need to configure three separate values. Real
 * names/handles are an operational decision this repo can't make on
 * its own — see docs/ops-alert-escalation.md for the actual documented
 * escalation path this is meant to plug into.
 */
function ownerForSeverity(severity: AlertSeverity): string {
  const specific = severity === "critical" ? process.env.OPS_ALERT_OWNER_CRITICAL : severity === "warning" ? process.env.OPS_ALERT_OWNER_WARNING : process.env.OPS_ALERT_OWNER_INFO;
  return specific ?? process.env.OPS_ALERT_OWNER ?? "(no owner configured — see docs/ops-alert-escalation.md)";
}

/**
 * Posts one alert to OPS_ALERT_WEBHOOK_URL, if configured. Returns
 * `true` only when a message was actually handed to Slack (a 2xx
 * response) — `false` means "not configured," a valid, common
 * deployment state (e.g. local dev) that callers must NOT record as a
 * real delivery. This distinction is real, not defensive: a live run
 * of this exact function once returned successfully (no throw) from a
 * machine mid-rollout that hadn't yet picked up a freshly-set
 * OPS_ALERT_WEBHOOK_URL, and the caller recorded alertedAt as if a
 * real alert had gone out when nothing had — caught by hand-verifying
 * the Slack channel, not by any code path noticing on its own. DOES
 * throw (OpsAlertDeliveryError) when a URL IS configured but the
 * delivery itself fails, so a caller running this inside a retryable
 * job (see worker.ts) gets real retry/backoff instead of a silently
 * swallowed failed alert — an alerting system that can't tell you it
 * failed to alert you isn't one you can trust.
 */
export async function sendOpsAlert(params: {
  severity: AlertSeverity;
  title: string;
  detail: string;
}): Promise<boolean> {
  const url = process.env.OPS_ALERT_WEBHOOK_URL;
  if (!url) return false;

  const owner = ownerForSeverity(params.severity);
  const emoji = params.severity === "critical" ? ":rotating_light:" : params.severity === "warning" ? ":warning:" : ":information_source:";
  const text = `${emoji} *[Anchor ${params.severity.toUpperCase()}]* ${params.title}\n${params.detail}\nAccountable owner: ${owner}`;

  try {
    await assertSafeToFetch(url);
  } catch (err) {
    throw new OpsAlertDeliveryError(`OPS_ALERT_WEBHOOK_URL is not safe to fetch: ${err instanceof Error ? err.message : String(err)}`);
  }

  let res: Response;
  try {
    res = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new OpsAlertDeliveryError(`failed to deliver ops alert: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    throw new OpsAlertDeliveryError(`ops alert endpoint responded ${res.status}`);
  }
  return true;
}
