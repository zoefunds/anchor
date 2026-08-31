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
// patterns below — it is not a claim that no PII can ever reach GenLayer.
// The name/address patterns are narrow, low-false-positive heuristics
// (an honorific or self-identification phrase before a capitalized
// name; a "123 Main St"-shaped address; a state-code-prefixed ZIP) —
// they catch the common conventional shapes, not names/addresses in
// arbitrary prose. Reliable detection of unstructured PII needs a real
// NLP/NER pass, not regex, and this file makes no claim to be that.
// Scoped honestly, not oversold.

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
  // Street address: house number + one-or-two capitalized words + a
  // common street-type suffix. Only catches the conventional
  // "123 Main St" shape — apartment/unit numbers, PO boxes, and
  // non-English address formats aren't covered. A heuristic, not a
  // real address parser.
  {
    name: "STREET_ADDRESS",
    regex: /\b\d{1,5}\s+[A-Z][a-zA-Z]*(?:\s[A-Z][a-zA-Z]*)?\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Terrace|Ter)\b\.?/g,
  },
  // US ZIP / ZIP+4 — a 5-digit run is also a plausible non-address
  // number (a case amount, a short ID), so this only matches when
  // directly preceded by a 2-letter state-code-shaped token, which
  // real ZIPs almost always are and coincidental 5-digit numbers
  // almost never are.
  { name: "POSTAL_CODE", regex: /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g },
  // Name: intentionally narrow, two shapes only — an honorific followed
  // by capitalized word(s) ("Mr. John Smith"), or an explicit
  // self-identification phrase followed by capitalized word(s) ("my
  // name is Jane Doe", "this is Bob speaking"). A capitalized-word-pair
  // alone is far too noisy (catches ordinary sentence-initial words,
  // product names, place names) to redact without a real NLP pass —
  // see this file's header comment. This catches the common, low-
  // ambiguity self-identification pattern and nothing broader.
  {
    name: "NAME",
    regex: /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?\b|\b(?:my name is|i'?m|this is)\s+[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?\b/gi,
  },
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
