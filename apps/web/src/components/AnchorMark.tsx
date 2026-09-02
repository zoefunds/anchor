// The Anchor glyph — a benchmark disc's engraved mark, not a ship's
// anchor: a ring, a shank, a stock, two flukes, five strokes at one
// weight. See docs/production-readiness-hardening-pass.md's brand work
// for the full rationale. Renders in `currentColor` so it always
// matches whatever text color classes wrap it (e.g. the nav's
// `text-ink-950 dark:text-ink`) — no separate dark-mode logic needed
// here, it just inherits the same one every other themed element uses.
export function AnchorMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth="7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="50" cy="21" r="9" />
      <line x1="50" y1="30" x2="50" y2="74" />
      <line x1="36" y1="41" x2="64" y2="41" />
      <path d="M50,74 Q25,76 22,50" />
      <path d="M50,74 Q75,76 78,50" />
    </svg>
  );
}
