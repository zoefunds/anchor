"use client";

import { useEffect, useState } from "react";

// A guided, multi-step explanation of Anchor for new users, reopenable
// any time from the docket page. Deliberately a modal walkthrough (not a
// live spotlight tour that highlights elements on the actual page) —
// it needs to explain the case detail page and every settings page too,
// and none of those are reachable from the docket without navigating
// away, which would make a live tour fragile and hard to resume. State
// (has this member seen it) lives in localStorage only, per this
// session's own decision — it resets if they switch browsers or clear
// site data, which is an acceptable tradeoff for something reopenable
// with one click.
const STORAGE_KEY = "anchor_walkthrough_seen_v1";

interface Step {
  title: string;
  body: string[];
}

const STEPS: Step[] = [
  {
    title: "Welcome to Anchor",
    body: [
      "Anchor is a dispute resolution and settlement platform. A dispute (a case) is decided by GenLayer, an AI adjudication network, and the decision can trigger a real on-chain payout from funds held in escrow.",
      "This walkthrough covers every screen and button you'll use: the docket, filing a case, the case detail page, and every settings page. You can reopen it any time from the button next to \"File a new case.\"",
    ],
  },
  {
    title: "The docket",
    body: [
      "The docket is the table of every case your organization has filed: its status, claim, amount, and the two parties involved.",
      "Click any row to open that case's own detail page, where you'll manage evidence, settlement, and appeals.",
    ],
  },
  {
    title: "Filing a case",
    body: [
      "Policy: which adjudication template GenLayer uses to decide this dispute. Each template defines what kind of dispute it handles and which evidence types it expects.",
      "Claim, Amount, Claimant, Respondent: a short description of the dispute, the amount at stake (in the settlement chain's own asset, ETH or SOL), and a reference for each party.",
      "Settlement target (optional): the chain and contract that will actually hold and pay out funds once a decision is reached. Leave this blank if you only want a recorded decision with no on-chain payout.",
    ],
  },
  {
    title: "Party links",
    body: [
      "After you file a case, you get one-time claimant and respondent links. Hand each one to the actual person on that side of the dispute.",
      "A party link lets someone view the case, submit their own evidence, set their payout address, and file an appeal, all without needing an Anchor account.",
      "These links are shown exactly once. If a link is lost, you can reissue it from the case detail page.",
    ],
  },
  {
    title: "Case status, start to finish",
    body: [
      "A case moves through: Open, Evidence collection, Submitted, Adjudicating, Accepted, Appeal window, Appealed (if contested), Re-adjudicating, then Finalized.",
      "Undetermined means GenLayer couldn't reach a confident decision. Cancelled means the case was withdrawn before a decision.",
    ],
  },
  {
    title: "Case page: escrow and settlement",
    body: [
      "The Escrow section shows deposit status and a checklist: both parties setting their payout address, the deposit being confirmed on-chain, and the case being settled.",
      "The Sync button forces an immediate check instead of waiting for the automatic background sweep, which runs on its own every few minutes regardless.",
    ],
  },
  {
    title: "Case page: evidence and exhibits",
    body: [
      "Exhibits are the evidence a policy requires. Some types are filed by your organization directly (documentation you already hold, like a task spec or invoice terms). Others can only be filed by the claimant or respondent themselves, through their own party link (their side of the story).",
      "Each exhibit shows who actually filed it.",
    ],
  },
  {
    title: "Case page: verdict and appeal",
    body: [
      "Once GenLayer decides, you'll see the outcome, its consensus strength, and how the amount is split between the two parties.",
      "Either party can appeal within the appeal window shown on the case page. An appeal triggers one fresh, independent re-adjudication round, not a review of the first one, and a case only ever gets one appeal.",
    ],
  },
  {
    title: "Case page: access and review",
    body: [
      "Restrict a case to specific members if it shouldn't be visible to your whole organization.",
      "Some cases are automatically held for human review, for example a fraud-risk flag or a filed appeal. Settlement stays paused until that review is approved from the Review queue in settings.",
    ],
  },
  {
    title: "Settings: Policies",
    body: [
      "Your organization's own governance configuration: evidence deadlines, appeal windows, allowed outcomes, allowed chains and assets, KYC requirement, and an auto-settlement cap. One policy binds automatically to each adjudication template.",
    ],
  },
  {
    title: "Settings: the rest",
    body: [
      "Review queue: cases currently held for human approval before settlement can proceed.",
      "Analytics and Usage & billing: activity and consumption for your organization.",
      "Settlement integrations: the chains and contracts your cases can settle against.",
      "Webhooks: subscribe an endpoint of yours to case and settlement events.",
      "Reconciliation findings, Cutover readiness, and Reliability: operational health checks, mainly useful once you're running real settlement volume.",
      "Audit log: a record of every sensitive action taken in your organization.",
      "Members and API keys: who and what can access your organization, and with what permissions.",
    ],
  },
  {
    title: "You're set",
    body: [
      "That's everything. Reopen this walkthrough any time from the docket page if you want a refresher, or if you're introducing someone new to Anchor.",
    ],
  },
];

function hasSeenWalkthrough(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markWalkthroughSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Private browsing / storage blocked - the walkthrough just reopens
    // on every visit instead of only the first, which is harmless.
  }
}

export function Walkthrough() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!hasSeenWalkthrough()) {
      setOpen(true);
    }
  }, []);

  function close() {
    markWalkthroughSeen();
    setOpen(false);
    setStep(0);
  }

  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        Take the tour
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="dossier w-full max-w-lg bg-white dark:bg-ink-950">
            <div className="flex items-baseline justify-between">
              <p className="kicker text-seal-500 dark:text-seal-400">
                {step + 1} of {STEPS.length}
              </p>
              <button
                type="button"
                onClick={close}
                className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
              >
                Skip
              </button>
            </div>

            <h2 className="mt-3 font-display text-2xl font-semibold text-ink-950 dark:text-ink">
              {STEPS[step].title}
            </h2>

            <div className="mt-4 flex flex-col gap-3 text-sm text-muted dark:text-muted-dark">
              {STEPS[step].body.map((paragraph, i) => (
                <p key={i}>{paragraph}</p>
              ))}
            </div>

            <div className="mt-8 flex items-center justify-between border-t border-line pt-6 dark:border-line-dark">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0}
              >
                Back
              </button>
              {step < STEPS.length - 1 ? (
                <button type="button" className="btn-primary" onClick={() => setStep((s) => s + 1)}>
                  Next
                </button>
              ) : (
                <button type="button" className="btn-primary" onClick={close}>
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
