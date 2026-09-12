// Real P1 fixed here (external audit finding, raised across multiple
// passes): case creation validated `amount` with `Number(amount)`,
// which accepts scientific notation ("1e21"), hex-like strings
// ("0x10" -> 16), leading/trailing whitespace, and — critically — if
// the caller's JSON body has `amount` as a numeric literal rather than
// a string, precision is already lost during JSON.parse itself, before
// this code ever runs (JS numbers are IEEE-754 doubles; a value like
// 9007199254740993 silently becomes 9007199254740992 on the wire).
// `Number()` validating a value doesn't mean the value that gets
// stored is what the caller actually meant.
//
// This enforces a canonical decimal STRING only — JSON numeric
// literals are rejected outright, not coerced — matching the DB
// column's own precision (`numeric(65,30)`, see prisma/schema.prisma's
// Case.amount) so nothing this accepts can silently be truncated or
// overflow at the storage layer either.

const CANONICAL_DECIMAL_PATTERN = /^(0|[1-9]\d{0,34})(\.\d{1,30})?$/;

export class InvalidAmountError extends Error {}

/**
 * Validates `raw` as a canonical positive decimal string and returns it
 * unchanged (never coerced to a JS number — that would reintroduce the
 * exact precision loss this exists to prevent). Throws InvalidAmountError
 * with a specific, actionable message on any rejection.
 */
export function parseCanonicalDecimalAmount(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new InvalidAmountError(
      `amount must be a JSON string (e.g. "123.45"), not a ${typeof raw} — numeric JSON literals lose precision during parsing before validation ever runs`
    );
  }
  const trimmed = raw.trim();
  if (trimmed !== raw) {
    throw new InvalidAmountError("amount must not have leading or trailing whitespace");
  }
  if (!CANONICAL_DECIMAL_PATTERN.test(raw)) {
    throw new InvalidAmountError(
      `amount "${raw}" is not a canonical decimal string — no scientific notation, no leading zeros (except a bare "0"), no sign, digits and an optional "." only, at most 35 integer digits and 30 fractional digits`
    );
  }
  if (/^0(\.0+)?$/.test(raw) || raw === "0") {
    throw new InvalidAmountError("amount must be greater than zero");
  }
  return raw;
}

/**
 * Converts a canonical decimal amount string to atomic units for an
 * asset with the given decimal count — the ONE place in the codebase
 * that should ever do this conversion, rather than a hardcoded
 * 18-decimals assumption baked into each call site. genlayer.ts's
 * toAttoAmount is now a thin wrapper around this for backward
 * compatibility with existing native-ETH callers.
 */
export function toAtomicAmount(amount: number | string, decimals: number): bigint {
  const str = typeof amount === "number" ? amount.toString() : amount;
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`toAtomicAmount: not a valid decimal string: ${str}`);
  }
  if (str.startsWith("-")) {
    throw new Error(`toAtomicAmount: amount must not be negative: ${str}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`toAtomicAmount: decimals must be a non-negative integer, got ${decimals}`);
  }
  const [whole, frac = ""] = str.split(".");
  if (frac.length > decimals) {
    throw new Error(`toAtomicAmount: amount has more than ${decimals} fractional digits, would lose precision: ${str}`);
  }
  const fracPadded = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}
