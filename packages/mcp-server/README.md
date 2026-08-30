# @anchor/mcp-server

An MCP (Model Context Protocol) server that exposes Anchor's Adjudication-
as-a-Service API as tools any MCP-compatible agent can call directly — no
custom HTTP client, no reading the API docs to figure out request shapes.

It's a thin wrapper: every tool call goes through the same
`Authorization: Bearer ak_live_...` API-key path a hand-rolled integration
would use (see `apps/web/src/lib/auth.ts`). This server holds no special
privilege over the REST API — it's just a typed, discoverable front door
to it.

## Tools

| Tool | What it does |
|---|---|
| `anchor_list_policies` | List available adjudication policies and their required evidence types |
| `anchor_create_case` | Open a new dispute case under a named policy |
| `anchor_list_cases` | List every case in the org |
| `anchor_get_case` | Fetch a case's status, evidence, and decision |
| `anchor_submit_evidence` | File inline text/JSON evidence |
| `anchor_submit_evidence_file` | Upload an image/PDF exhibit from a local file path |
| `anchor_submit_for_adjudication` | Submit a case for GenLayer consensus |
| `anchor_appeal_case` | Appeal a decided case within its appeal window |

## Setup

```bash
cd packages/mcp-server
npm install
npm run build
```

Get an API key from your Anchor dashboard: **Settings → API keys → Issue key**.

## Plugging into an agent

### Claude Desktop / Claude Code

Add to `claude_desktop_config.json` (or the equivalent MCP config for your
client):

```json
{
  "mcpServers": {
    "anchor": {
      "command": "node",
      "args": ["/absolute/path/to/anchor-/packages/mcp-server/dist/index.js"],
      "env": {
        "ANCHOR_API_KEY": "ak_live_...",
        "ANCHOR_BASE_URL": "https://your-anchor-deployment.example.com"
      }
    }
  }
}
```

`ANCHOR_BASE_URL` defaults to `http://localhost:3000` if omitted — fine for
local development against `apps/web`'s dev server, but set it explicitly
for any real deployment.

### Any other MCP client

This is a standard stdio-transport MCP server (`StdioServerTransport` from
`@modelcontextprotocol/sdk`) — anything that speaks MCP over stdio can run
it the same way: `node dist/index.js` with `ANCHOR_API_KEY` and
`ANCHOR_BASE_URL` in its environment.

## Local development

```bash
npm run dev   # runs src/index.ts directly via tsx, no build step
```

## Notes

- File uploads (`anchor_submit_evidence_file`) read from a **local
  filesystem path** the MCP server process can access — that's the agent
  host's filesystem, not Anchor's. Allowed types: png/jpeg/webp/gif/pdf,
  15MB max (same limits as the dashboard's upload endpoint).
- Every tool surfaces Anchor's real API errors (missing evidence, wrong
  case status, rate limits) as MCP tool errors rather than swallowing
  them — an agent calling `anchor_submit_for_adjudication` too early will
  see the same `400` with the specific missing evidence types a human
  would see in the dashboard.
- This package is not published; run it from a local build (see Setup).
