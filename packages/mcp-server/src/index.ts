#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AnchorClient, AnchorApiError } from "./client.js";

const baseUrl = process.env.ANCHOR_BASE_URL ?? "http://localhost:3000";
const apiKey = process.env.ANCHOR_API_KEY;
if (!apiKey) {
  console.error("ANCHOR_API_KEY is not set. Issue one from your Anchor dashboard's Settings -> API keys.");
  process.exit(1);
}

const anchor = new AnchorClient({ baseUrl, apiKey });

const server = new McpServer({
  name: "anchor",
  version: "0.1.0",
});

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof AnchorApiError ? `${err.message} (HTTP ${err.status})` : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

server.registerTool(
  "anchor_list_policies",
  {
    title: "List adjudication policies",
    description:
      "Lists Anchor's available adjudication policies (agent_data_task_v1, escrow_release_v1, invoice_dispute_v1, etc.), each with its required evidence types. Call this before creating a case to pick the policy that fits the dispute, or to know what evidence to gather.",
    inputSchema: {},
  },
  async () => {
    try {
      return textResult(await anchor.listPolicies());
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "anchor_create_case",
  {
    title: "Open a new dispute case",
    description:
      "Opens a new case under a named policy. claimantRef/respondentRef must already be pseudonymous references (e.g. 'party_7F82A') — never send real identities, Anchor's GenLayer contract never sees them either. Returns the created case, including its id, which every subsequent tool call needs.",
    inputSchema: {
      claim: z.string().describe("Short claim identifier, e.g. 'service_not_delivered'"),
      amount: z.number().positive().describe("Disputed amount, as a plain decimal number (e.g. 1000.00)"),
      currency: z.string().optional().describe("Currency code, defaults to USD"),
      claimantRef: z.string().describe("Pseudonymous reference for the claimant"),
      respondentRef: z.string().describe("Pseudonymous reference for the respondent"),
      policyId: z.string().optional().describe("Policy id from anchor_list_policies; defaults to agent_data_task_v1"),
    },
  },
  async (args) => {
    try {
      return textResult(await anchor.createCase(args));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "anchor_list_cases",
  {
    title: "List cases",
    description: "Lists every case belonging to this API key's organization, most recent first.",
    inputSchema: {},
  },
  async () => {
    try {
      return textResult(await anchor.listCases());
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "anchor_get_case",
  {
    title: "Get a case",
    description:
      "Fetches a case's current status, evidence, and decision (if any). Poll this after anchor_submit_for_adjudication or anchor_appeal_case — real GenLayer consensus takes ~1-2 minutes, so status stays ADJUDICATING/RE_ADJUDICATING until it resolves.",
    inputSchema: {
      caseId: z.string(),
    },
  },
  async ({ caseId }) => {
    try {
      return textResult(await anchor.getCase(caseId));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "anchor_submit_evidence",
  {
    title: "Submit inline text/JSON evidence",
    description:
      "Files one exhibit of inline text or JSON content against a case, for a required evidence type from its policy (see anchor_list_policies). For images or PDFs, use anchor_submit_evidence_file instead.",
    inputSchema: {
      caseId: z.string(),
      type: z.string().describe("Evidence type name required by the case's policy, e.g. 'task_spec'"),
      content: z.string().describe("The evidence content itself"),
      submittedBy: z.enum(["claimant", "respondent"]).optional(),
    },
  },
  async ({ caseId, type, content, submittedBy }) => {
    try {
      return textResult(await anchor.submitEvidence(caseId, { type, content, submittedBy }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "anchor_submit_evidence_file",
  {
    title: "Submit image/PDF evidence from a local file",
    description:
      "Uploads an image or PDF from a local filesystem path as an exhibit. Images are genuinely interpreted visually by the GenLayer contract (real multimodal LLM input, not OCR) - PDFs are only confirmed reachable, their content is never machine-read. Allowed: png/jpeg/webp/gif/pdf, 15MB max.",
    inputSchema: {
      caseId: z.string(),
      type: z.string().describe("Evidence type name required by the case's policy, e.g. 'deliverable'"),
      filePath: z.string().describe("Absolute local filesystem path to the image or PDF to upload"),
    },
  },
  async ({ caseId, type, filePath }) => {
    try {
      const fileBytes = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      const mimeType = MIME_BY_EXT[ext];
      if (!mimeType) {
        return errorResult(new Error(`unsupported file extension ${ext} — allowed: ${Object.keys(MIME_BY_EXT).join(", ")}`));
      }
      return textResult(
        await anchor.submitEvidenceFile(caseId, { type, fileBytes, filename: filePath.split("/").pop() ?? "evidence", mimeType })
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "anchor_submit_for_adjudication",
  {
    title: "Submit a case for adjudication",
    description:
      "Submits a case for GenLayer adjudication once all required evidence is on file. Returns immediately (202) with status ADJUDICATING - real consensus takes ~1-2 minutes, poll anchor_get_case for the result rather than assuming it's done.",
    inputSchema: {
      caseId: z.string(),
    },
  },
  async ({ caseId }) => {
    try {
      return textResult(await anchor.submitForAdjudication(caseId));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "anchor_appeal_case",
  {
    title: "Appeal a decided case",
    description:
      "Appeals a case within its APPEAL_WINDOW (48 hours after a decision), triggering exactly one fresh, independent re-adjudication round - capped on-chain by the contract itself, a second appeal is rejected. Correct evidence first with anchor_submit_evidence(_file) if needed - during the appeal window, resubmitting an existing type replaces it for the re-run.",
    inputSchema: {
      caseId: z.string(),
      reason: z.string().optional().describe("Optional human-readable reason for the appeal, recorded in the audit log"),
    },
  },
  async ({ caseId, reason }) => {
    try {
      return textResult(await anchor.appealCase(caseId, reason));
    } catch (err) {
      return errorResult(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Anchor MCP server running (${baseUrl})`);
