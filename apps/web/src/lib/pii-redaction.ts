// Best-effort PII redaction applied to free-text party statement fields
// (claimant_statement/respondent_statement) before they reach GenLayer —
// see adjudication-service.ts. Deliberately NOT applied to substantive
// evidence fields (task_spec, delivery_payload, milestone_spec,
// deliverable, invoice_terms, delivery_record): those are the actual
// content the policy has to compare against a spec, and a false-positive
// redaction there (e.g. an invoice's real delivery address, a task spec
// requiring a contact email to be included in the delivery) would
// silently corrupt the thing being adjudicated. Statements are free-text
// narrative where PII is much more likely incidental commentary than the
// substance of the dispute.
//
// This is a real, working mitigation for the common, structured PII
// patterns below — it is not a claim that no PII can ever reach GenLayer
// (unstructured PII like a name in prose isn't reliably detectable by
// regex, and never will be without a much heavier NLP pass). Scoped
// honestly, not oversold.

const PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "EMAIL", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  // US SSN (###-##-####) — checked before the generic phone pattern so a
  // 9-digit hyphenated SSN doesn't also get caught by the looser phone regex.
  { name: "SSN", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit card: the two realistic real-world shapes — grouped in 4s
  // (the overwhelmingly common presentation) or one continuous 13-19
  // digit run. Deliberately not "any digit run with optional per-digit
  // separators" — that shape also matches ordinary long numeric IDs
  // (tracking numbers, invoice numbers) far too easily for a heuristic
  // this coarse.
  { name: "CREDIT_CARD", regex: /\b(?:\d{4}[ -]){3}\d{1,4}\b|\b\d{13,19}\b/g },
  // Phone: a loose international-ish pattern — optional +country code,
  // then 7-14 digits with optional separators. Deliberately permissive
  // (better to over-redact an ambiguous digit string in a *statement*
  // field than under-redact a real phone number).
  { name: "PHONE", regex: /\+?\d{1,3}?[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g },
];

export function redactPii(text: string): string {
  let result = text;
  for (const { name, regex } of PATTERNS) {
    result = result.replace(regex, `[REDACTED_${name}]`);
  }
  return result;
}

/** Fields this redaction applies to — free-text party commentary, never the substantive evidence being adjudicated. See this module's header comment for why the split matters. */
export const REDACTED_EVIDENCE_TYPES = new Set(["claimant_statement", "respondent_statement"]);
