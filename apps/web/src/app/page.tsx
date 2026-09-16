import Link from "next/link";
import { AnchorMark } from "@/components/AnchorMark";

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-ledger-lines bg-[length:100%_40px] text-line/40 dark:text-line-dark/25"
      />

      <div className="relative mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-8 py-24">
        <AnchorMark className="mb-8 h-8 w-8 text-seal-500 dark:text-seal-400" />

        <p className="kicker mb-6 text-seal-500 dark:text-seal-400">
          Adjudication infrastructure
        </p>

        <h1 className="font-display text-6xl font-semibold leading-[0.95] tracking-tight text-ink-950 dark:text-ink sm:text-7xl">
          Anchor
        </h1>

        <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted dark:text-muted-dark">
          A record of what happened, and what should happen next. Anchor settles disputes
          between agents and counterparties with evidence, a named policy, and an
          independently verified verdict, not a single model's opinion.
        </p>

        <div className="mt-10 flex items-center gap-6">
          <Link href="/cases" className="btn-primary">
            Open the docket
          </Link>
          <span className="font-mono text-xs text-muted dark:text-muted-dark">
            verdicts run on GenLayer consensus
          </span>
        </div>

        <dl className="mt-20 grid grid-cols-3 gap-8 border-t border-line pt-8 dark:border-line-dark">
          <div>
            <dt className="kicker mb-1">Evidence</dt>
            <dd className="text-sm text-muted dark:text-muted-dark">
              Structured, hashed, and versioned against a named policy.
            </dd>
          </div>
          <div>
            <dt className="kicker mb-1">Consensus</dt>
            <dd className="text-sm text-muted dark:text-muted-dark">
              Independent validators, not one model grading its own work.
            </dd>
          </div>
          <div>
            <dt className="kicker mb-1">Verdict</dt>
            <dd className="text-sm text-muted dark:text-muted-dark">
              A structured decision an escrow contract can act on directly.
            </dd>
          </div>
        </dl>
      </div>
    </main>
  );
}
