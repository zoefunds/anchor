import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont } from "pdf-lib";
import {
  buildCaseStatement,
  buildProofBundle,
  buildDepositReceipt,
  buildSettlementReceipt,
  buildDecisionRecord,
  buildAppealRecord,
} from "@/lib/receipts";

// Every generated PDF carries this banner so nobody mistakes a Sepolia
// testnet artifact for a document with real financial effect.
const TESTNET_BANNER = "TESTNET — no real value — Sepolia/Solana testnet only, no live funds";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const LINE_HEIGHT = 16;

class PdfWriter {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  page: PDFPage;
  y: number;

  private constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  static async create(): Promise<PdfWriter> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    return new PdfWriter(doc, font, bold);
  }

  private ensureSpace() {
    if (this.y < MARGIN + LINE_HEIGHT) {
      this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.y = PAGE_HEIGHT - MARGIN;
    }
  }

  title(text: string) {
    this.ensureSpace();
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 16, font: this.bold, color: rgb(0, 0, 0) });
    this.y -= LINE_HEIGHT * 1.5;
  }

  heading(text: string) {
    this.ensureSpace();
    this.y -= 4;
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 12, font: this.bold, color: rgb(0, 0, 0) });
    this.y -= LINE_HEIGHT;
  }

  text(text: string) {
    const maxChars = 95;
    const lines = wrapText(text, maxChars);
    for (const line of lines) {
      this.ensureSpace();
      this.page.drawText(line, { x: MARGIN, y: this.y, size: 10, font: this.font, color: rgb(0.1, 0.1, 0.1) });
      this.y -= LINE_HEIGHT;
    }
  }

  field(label: string, value: string | number | boolean | null | undefined) {
    this.text(`${label}: ${value === null || value === undefined || value === "" ? "—" : String(value)}`);
  }

  spacer() {
    this.y -= LINE_HEIGHT / 2;
  }

  banner(text: string) {
    this.ensureSpace();
    this.y -= 6;
    this.page.drawRectangle({ x: MARGIN, y: this.y - 4, width: PAGE_WIDTH - MARGIN * 2, height: LINE_HEIGHT + 6, color: rgb(0.95, 0.85, 0.2) });
    this.page.drawText(text, { x: MARGIN + 6, y: this.y, size: 10, font: this.bold, color: rgb(0.35, 0.2, 0) });
    this.y -= LINE_HEIGHT + 10;
  }

  async finalize(generatedAt: string): Promise<Uint8Array> {
    for (const p of this.doc.getPages()) {
      p.drawText(`Generated ${generatedAt} — ${TESTNET_BANNER}`, {
        x: MARGIN,
        y: 24,
        size: 7,
        font: this.font,
        color: rgb(0.4, 0.4, 0.4),
      });
    }
    return this.doc.save();
  }
}

function wrapText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Org-facing (behind auth) — full lifecycle statement including claim text and settlement details. Not intended for public/shareable distribution as-is: it carries more than lib/receipts.ts's public case route exposes (e.g. review/riskAssessment internals). */
export async function generateCaseStatementPdf(caseId: string, organizationId: string): Promise<Uint8Array> {
  const doc = await buildCaseStatement(caseId, organizationId);
  const w = await PdfWriter.create();
  w.title("Case Statement");
  w.banner(TESTNET_BANNER);
  w.heading("Case");
  w.field("Case ID", doc.case.id);
  w.field("Status", doc.case.status);
  w.field("Claim", doc.case.claim);
  w.field("Amount", `${doc.case.amount} ${doc.case.currency}`);
  w.field("Claimant ref", doc.case.claimantRef);
  w.field("Respondent ref", doc.case.respondentRef);
  w.field("Created at", doc.case.createdAt);
  w.spacer();

  w.heading("Policy binding");
  if (doc.policy) {
    w.field("Policy version ID", doc.policy.policyVersionId);
    w.field("Version", doc.policy.version);
    w.field("Evidence deadline (hrs)", doc.policy.evidenceDeadlineHours);
    w.field("Appeal window (hrs)", doc.policy.appealWindowHours);
    w.field("KYC required", doc.policy.kycRequired);
  } else {
    w.text("No policy version bound.");
  }
  w.spacer();

  w.heading("Decisions");
  if (doc.decisions.length === 0) {
    w.text("No decisions yet.");
  }
  for (const d of doc.decisions) {
    w.field("Decision ID", d.id);
    w.field("Outcome", d.outcome);
    w.field("Consensus", d.consensus);
    w.field("Claimant share (bps)", d.claimantShareBps);
    w.field("Respondent share (bps)", d.respondentShareBps);
    w.field("Reason codes", d.reasonCodes.join(", "));
    w.field("Decision hash", d.decisionHash);
    w.field("Proof hash", d.proofHash);
    w.field("Contract code hash", d.contractCodeHash);
    w.field("Adjudicate tx hash", d.adjudicateTxHash);
    w.field("Created at", d.createdAt);
    w.spacer();
  }

  w.heading("Settlement");
  if (doc.settlement) {
    w.field("Status", doc.settlement.status);
    w.field("Chain", doc.settlement.chain);
    w.field("Asset", `${doc.settlement.asset.assetSymbol} (${doc.settlement.asset.testnetNotice ?? "native asset"})`);
    w.field("Amount", `${doc.settlement.asset.humanAmount} ${doc.settlement.asset.assetSymbol}`);
    w.field("Deposit tx hash", doc.settlement.depositTxHash);
    w.field("Settled tx hash", doc.settlement.settledTxHash);
    w.field("Settled at", doc.settlement.settledAt);
  } else {
    w.text("No settlement configured for this case.");
  }

  return w.finalize(doc.generatedAt);
}

/** Org-facing (behind auth) — evidence + decision proof manifest, same hash fields as the public verify endpoint. Structurally shareable (no PII fields present), but kept behind org auth here since it is served from the org-scoped route; a public-facing verification page should call buildProofBundle/this function's data independent of case-internal fields. */
export async function generateEvidenceReceiptPdf(caseId: string, organizationId: string): Promise<Uint8Array> {
  const doc = await buildProofBundle(caseId, organizationId);
  const w = await PdfWriter.create();
  w.title("Evidence Receipt");
  w.banner(TESTNET_BANNER);
  w.field("Case ID", doc.caseId);
  w.field("Policy version ID", doc.policyVersionId);
  w.spacer();
  w.heading("Decision proof manifest");
  if (doc.decision) {
    w.field("Decision hash", doc.decision.decisionHash);
    w.field("Proof hash", doc.decision.proofHash);
    w.field("Contract code hash", doc.decision.contractCodeHash);
    w.field("Evidence manifest hash", doc.decision.evidenceManifestHash);
    w.field("Evidence used", doc.decision.evidenceUsed.join(", "));
    w.field("Adjudicate tx hash", doc.decision.adjudicateTxHash);
  } else {
    w.text("No decision yet — nothing to attest.");
  }
  w.spacer();
  w.text(doc.verificationNote);
  return w.finalize(doc.generatedAt);
}

/** Org-facing (behind auth) — narrative decision record: outcome, shares, reason codes, explanation, plus proof hashes. Contains only case/decision fields, no claimant/respondent PII beyond the refs already visible on the public case page. */
export async function generateDecisionRecordPdf(caseId: string, organizationId: string, decisionId?: string): Promise<Uint8Array> {
  const doc = await buildDecisionRecord(caseId, organizationId, decisionId);
  const w = await PdfWriter.create();
  w.title("Decision Record");
  w.banner(TESTNET_BANNER);
  w.field("Case ID", doc.caseId);
  w.field("Policy version ID", doc.policyVersionId);
  w.field("Policy version", doc.policyVersion);
  w.spacer();
  w.heading("Decision");
  w.field("Decision ID", doc.decision.id);
  w.field("Outcome", doc.decision.outcome);
  w.field("Consensus", doc.decision.consensus);
  w.field("Confidence", doc.decision.confidence);
  w.field("Claimant share (bps)", doc.decision.claimantShareBps);
  w.field("Respondent share (bps)", doc.decision.respondentShareBps);
  w.field("Reason codes", doc.decision.reasonCodes.join(", "));
  if (doc.decision.explanation) w.text(`Explanation: ${doc.decision.explanation}`);
  w.field("Decision hash", doc.decision.decisionHash);
  w.field("Proof hash", doc.decision.proofHash);
  w.field("Contract code hash", doc.decision.contractCodeHash);
  w.field("Adjudicate tx hash", doc.decision.adjudicateTxHash);
  w.field("Appeal window closes at", doc.decision.appealWindowClosesAt);
  w.field("Created at", doc.decision.createdAt);
  return w.finalize(doc.generatedAt);
}

/** Org-facing (behind auth) — the appeal (re-adjudication) record, showing the original decision it superseded and the new outcome/hashes. No PII beyond decision-level fields. */
export async function generateAppealRecordPdf(caseId: string, organizationId: string): Promise<Uint8Array> {
  const doc = await buildAppealRecord(caseId, organizationId);
  const w = await PdfWriter.create();
  w.title("Appeal Record");
  w.banner(TESTNET_BANNER);
  w.field("Case ID", doc.caseId);
  w.field("Policy version ID", doc.policyVersionId);
  w.field("Case status", doc.caseStatus);
  w.spacer();
  w.heading("Original decision");
  w.field("Decision ID", doc.originalDecision.id);
  w.field("Outcome", doc.originalDecision.outcome);
  w.field("Claimant share (bps)", doc.originalDecision.claimantShareBps);
  w.field("Respondent share (bps)", doc.originalDecision.respondentShareBps);
  w.field("Decision hash", doc.originalDecision.decisionHash);
  w.field("Created at", doc.originalDecision.createdAt);
  w.spacer();
  w.heading("Appeal decision");
  w.field("Decision ID", doc.appealDecision.id);
  w.field("Outcome", doc.appealDecision.outcome);
  w.field("Consensus", doc.appealDecision.consensus);
  w.field("Claimant share (bps)", doc.appealDecision.claimantShareBps);
  w.field("Respondent share (bps)", doc.appealDecision.respondentShareBps);
  w.field("Reason codes", doc.appealDecision.reasonCodes.join(", "));
  if (doc.appealDecision.explanation) w.text(`Explanation: ${doc.appealDecision.explanation}`);
  w.field("Decision hash", doc.appealDecision.decisionHash);
  w.field("Proof hash", doc.appealDecision.proofHash);
  w.field("Contract code hash", doc.appealDecision.contractCodeHash);
  w.field("Adjudicate tx hash", doc.appealDecision.adjudicateTxHash);
  w.field("Created at", doc.appealDecision.createdAt);
  return w.finalize(doc.generatedAt);
}

/** Org-facing (behind auth) — release/refund/partial-settlement receipt, the real dispatched settlement transaction. No claimant/respondent PII — only case ID, decision outcome/shares, and tx identifiers, a strict subset of what generateCaseStatementPdf includes, so this one specifically is safe to hand to either party of a dispute if a future flow needs to share it. */
export async function generateSettlementReceiptPdf(caseId: string, organizationId: string): Promise<Uint8Array> {
  const doc = await buildSettlementReceipt(caseId, organizationId);
  const w = await PdfWriter.create();
  w.title("Settlement Receipt");
  w.banner(TESTNET_BANNER);
  w.field("Case ID", doc.caseId);
  w.field("Policy version ID", doc.policyVersionId);
  w.field("Decision hash", doc.decisionHash);
  w.field("Outcome", doc.outcome);
  w.field("Claimant share (bps)", doc.claimantShareBps);
  w.field("Respondent share (bps)", doc.respondentShareBps);
  w.field("Relay tx hash", doc.relayTxHash);
  w.field("Relay message ID", doc.relayMessageId);
  w.field("Settled tx hash", doc.settledTxHash);
  w.field("Settled at", doc.settledAt);
  return w.finalize(doc.generatedAt);
}

/** Org-facing (behind auth) — proof a deposit was confirmed for this case's escrow binding, including chain/asset/contract details. */
export async function generateDepositReceiptPdf(caseId: string, organizationId: string): Promise<Uint8Array> {
  const doc = await buildDepositReceipt(caseId, organizationId);
  const w = await PdfWriter.create();
  w.title("Deposit Receipt");
  w.banner(TESTNET_BANNER);
  w.field("Case ID", doc.caseId);
  w.field("Policy version ID", doc.policyVersionId);
  w.field("Chain", doc.chain);
  w.field("Escrow contract address", doc.escrowContractAddress);
  w.field("Asset", `${doc.asset.assetSymbol} (${doc.asset.testnetNotice ?? "native asset"})`);
  w.field("Amount", `${doc.asset.humanAmount} ${doc.asset.assetSymbol}`);
  w.field("Deposit tx hash", doc.depositTxHash);
  w.field("Deposit confirmed at", doc.depositConfirmedAt);
  return w.finalize(doc.generatedAt);
}
