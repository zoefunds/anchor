const STATUS_META: Record<string, { label: string; colorClass: string }> = {
  OPEN: { label: "Open", colorClass: "border-status-pending text-status-pending" },
  EVIDENCE_COLLECTION: { label: "Evidence collection", colorClass: "border-status-active text-status-active" },
  SUBMITTED: { label: "Submitted", colorClass: "border-status-active text-status-active" },
  ADJUDICATING: { label: "Adjudicating", colorClass: "border-status-adjudicating text-status-adjudicating" },
  ACCEPTED: { label: "Accepted", colorClass: "border-status-accepted text-status-accepted" },
  APPEAL_WINDOW: { label: "Appeal window", colorClass: "border-status-accepted text-status-accepted" },
  APPEALED: { label: "Appealed", colorClass: "border-status-adjudicating text-status-adjudicating" },
  RE_ADJUDICATING: { label: "Re-adjudicating", colorClass: "border-status-adjudicating text-status-adjudicating" },
  FINALIZED: { label: "Finalized", colorClass: "border-status-accepted text-status-accepted" },
  UNDETERMINED: { label: "Undetermined", colorClass: "border-status-undetermined text-status-undetermined" },
  CANCELLED: { label: "Cancelled", colorClass: "border-status-pending text-status-pending" },
};

export function StatusStamp({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, colorClass: "border-status-pending text-status-pending" };
  return <span className={`docket-stamp ${meta.colorClass}`}>{meta.label}</span>;
}
