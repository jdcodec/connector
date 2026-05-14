# JD Codec Connector

```bash
npm install -g jdcodec
```

**Cut token cost on browser-agent tasks by ~80%+ with a drop-in local proxy. PII never leaves your machine.**

The JD Codec Connector is a local MCP (Model Context Protocol) proxy that sits between your agent and [Playwright MCP](https://github.com/microsoft/playwright-mcp). It compresses page snapshots before your agent sees them, using a cloud compression service. Large DOM/ARIA snapshots become compact deltas; your agent gets smaller inputs without losing the ability to act on any element.

**Privacy-first by design.** Every snapshot is scanned for PII on your machine before any bytes leave — emails, phone numbers, credit cards, API keys, addresses, and 30+ other categories are replaced with category tokens like `{{REDACTED_EMAIL}}` before transmission. If the cloud service is unreachable, the connector falls back to returning the (already-redacted) snapshot unchanged — your agent never blocks on us.

---

## What you need

- macOS or Linux
- Node.js 22 or newer (`node --version`)
- An MCP-capable agent client — Claude Code, Cursor, or any other client that can spawn an MCP stdio server
- A JD Codec API key — email `hello@jdcodec.com`

---

## Install

```bash
npm install -g jdcodec
```

This installs the `jdcodec` binary on your `PATH`. From there you can reference it directly in any MCP client config that spawns a stdio command. Verify with:

```bash
jdcodec --help
```

A Python distribution is also available — `pip install jdcodec` is a thin wrapper around the same connector binary, fetched and run via `npx`. Either entry point works; pick whichever fits your project's primary language.

---

## Configure your API key

Two options; pick one.

### Option A — environment variable

```bash
export JDC_API_KEY='jdck_yourid.yoursecret'
```

Best for one-off runs or when your agent framework already manages env vars.

### Option B — config file

```bash
mkdir -p ~/.jdcodec
cat > ~/.jdcodec/config.json <<EOF
{
  "api_key": "jdck_yourid.yoursecret"
}
EOF
chmod 600 ~/.jdcodec/config.json
```

Best for a persistent setup; the connector reads this automatically if `JDC_API_KEY` isn't set.

The `jdck_` prefix is the public part of your key (safe in logs and dashboards). The secret half after the dot is sensitive — treat the full bearer string like a password.

---

## Wire it into your agent

Any MCP-capable client that spawns a stdio command can use the connector — the swap is one line in your client config:

- **From** `command: "npx", args: ["@playwright/mcp", "--no-sandbox", "--isolated"]`
- **To**   `command: "jdcodec"` (no extra args needed; pass through any Playwright MCP args you were using)

The connector spawns Playwright MCP itself as a subprocess and proxies everything. Your agent sees the same tools it always did (`browser_snapshot`, `browser_click`, etc.) with no behaviour changes beyond smaller snapshots.

**Claude Code (CLI + Claude VS Code extension):** `claude mcp add --scope user jdcodec -- jdcodec`. Both the Claude Code terminal CLI and Anthropic's Claude VS Code extension read MCP servers from `~/.claude.json`, so this single command wires both.

**Cursor:** add to `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "jdcodec": { "command": "jdcodec", "env": { "JDC_API_KEY": "jdck_yourid.yoursecret" } } } }
```

**Generic MCP client (Python `mcp` SDK, TypeScript `@modelcontextprotocol/sdk`, etc.):** point the stdio spawn at `jdcodec` instead of `npx @playwright/mcp`. Email `hello@jdcodec.com` if you'd like a copy-paste config for your specific client.

---

## Verify it's working

Start any agent task that involves `browser_snapshot`. On stderr you should see structured log lines like:

```json
{"level":"info","event":"snapshot","frame":"…","input_chars":40123,"output_chars":5432,"reduction":0.86}
```

That `reduction: 0.86` is the per-snapshot compression ratio — the number of tokens your agent would have burned vs. what it actually received.

If you don't see those log lines within a few snapshots, see [Troubleshooting](#troubleshooting) below.

---

## Escape hatches

### `JDC_BYPASS=1` — skip the cloud

```bash
JDC_BYPASS=1 jdcodec
```

Runs the connector with the cloud disabled. Your agent still receives PII-redacted snapshots, but uncompressed. Useful for:

- Local debugging without network
- Comparing agent behaviour with vs. without compression
- Demonstrating the privacy shield in isolation

The `{{REDACTED_…}}` tokens will appear in the snapshots your agent sees. That's expected — the shield runs whether or not the cloud is called.

### `JDC_LLM_PROVIDER` — accurate savings numbers (optional, recommended)

```bash
export JDC_LLM_PROVIDER=anthropic          # one of: anthropic, openai, gemini
export JDC_LLM_MODEL=claude-sonnet-4-6     # optional, refines tokenizer for newer model families
```

**Why set this:** JDC compresses your snapshots, which shrinks the LLM bill you pay your provider. The size of that saving depends on which tokenizer your provider uses to count tokens — Anthropic, OpenAI, and Google each tokenize the same text differently, by up to ~22% on snapshot-style content. Telling JDC which provider you use lets it count tokens with the same tokenizer your provider does, so the saving numbers JDC reports back to you (in `jdcodec savings` and your usage reports) match what's actually showing up on your provider invoice. Without this, JDC quotes savings using an approximate tokenizer and labels the report as approximate so you know the difference.

**What JDC does with the value:** picks the right tokenizer for counting your tokens. That's all. It's not forwarded to your LLM provider, it doesn't change what's stored about your snapshots, and it isn't used to route your model calls — JDC never sees your LLM API key by design. The value travels with each snapshot request, the codec stores it on the session, and consults it when totalling tokens for your reports.

Two practical notes:

- **Aggregator routing**: if you call Claude through AWS Bedrock or Vertex, set `anthropic` (not `bedrock`/`vertex`) — the aggregator routes the request, but the underlying model still tokenizes. Same for Azure OpenAI → `openai`. The tokenizer family follows the model, not the transport.
- **First snapshot wins per session**: JDC binds your provider on the first snapshot of a session and ignores changes after that. Set it once and forget; rotating mid-task does nothing until the next session.

If `JDC_LLM_PROVIDER` is set to anything other than `anthropic`/`openai`/`gemini`, the connector logs a `config.agent_llm_invalid` warning at startup and falls back to the approximate tokenizer (so a typo doesn't silently leave you with wrong-looking numbers).

Alternative to env: add `agent_llm` to `~/.jdcodec/config.json`:

```json
{ "api_key": "jdck_yourid.yoursecret",
  "agent_llm": { "provider": "anthropic", "model": "claude-sonnet-4-6" } }
```

`JDC_LLM_PROVIDER` env wins over the file when both are present.

### `JDC_REGION` — pin to a region (optional)

Set to the closest Cloudflare region for lower latency on long-running sessions:

| Value | Region |
|---|---|
| `wnam` | Western North America |
| `enam` | Eastern North America |
| `sam` | South America |
| `weur` | Western Europe |
| `eeur` | Eastern Europe |
| `apac` | Asia-Pacific |
| `oc` | Oceania |
| `afr` | Africa |
| `me` | Middle East |

```bash
export JDC_REGION=oc   # e.g. Sydney
```

Default is "route to whichever edge is fastest for your first request." Setting this only helps on sessions that live more than a minute or two; short tasks won't notice the difference.

---

## Graceful degradation — what happens on failure

The connector is designed so your agent never blocks on us. Specifically:

- **Network error / timeout / cloud returns 5xx** → the (already-redacted) snapshot is forwarded to your agent unchanged; a `codec_unreachable` warning is logged to stderr. Your task continues.
- **API key invalid / revoked** → same behaviour; the connector logs the auth failure and falls through.
- **PII shield failure** → the connector returns an error to your agent rather than leaking unscanned bytes. This is the single case where a failure does reach your agent. Set `JDC_PRIVACY_FAIL_OPEN=1` to flip this to "log CRITICAL and pass the snapshot through unscanned" — only use this if you understand the privacy implications.

The cloud service targets ≥99.5% availability. In alpha you may see occasional `codec_unreachable` log lines during deploys — these are typically under a second and your agent will not notice.

---

## What's captured about your usage

For billing and debugging, we record one event per snapshot:

- `api_key_id` (the `jdck_` prefix, not the secret)
- session and task IDs (you choose them; we don't correlate across keys)
- timestamps, input/output character counts, latency metrics
- URL (after the PII shield has run over it)
- category counts from the PII shield (e.g. `{"email": 2}`) — **never the redacted values**

We do **not** store:

- raw snapshot content
- redacted URL paths or query strings beyond what fits in a URL
- anything the PII shield caught

Retention window is 90 days by default (configurable per-key). Email `hello@jdcodec.com` if you want the full data-handling summary or a shorter retention window on your key.

---

## Environment reference

| Variable | Required? | Default | What it does |
|---|---|---|---|
| `JDC_API_KEY` | yes¹ | — | Your bearer token, shape `jdck_id.secret`. |
| `JDC_BYPASS` | no | `0` | `1` skips the cloud entirely; shield still runs. |
| `JDC_CLOUD_URL` | no | `https://api.jdcodec.com` | Override endpoint. |
| `JDC_REGION` | no | — | Cloudflare region hint for session pinning. |
| `JDC_LLM_PROVIDER` | no (recommended) | — | Your LLM provider (`anthropic`/`openai`/`gemini`). Lets JDC quote savings using the same tokenizer your provider bills you with, so the numbers match your invoice. Unset = approximate savings, clearly labelled. |
| `JDC_LLM_MODEL` | no | — | Optional model identifier (e.g. `claude-sonnet-4-6`, `gpt-4o`). Refines the tokenizer choice on providers with multiple model generations. Ignored unless `JDC_LLM_PROVIDER` is also set. |
| `JDC_PLAYWRIGHT_CMD` | no | `npx` | Command to spawn the upstream MCP server. |
| `JDC_PLAYWRIGHT_ARGS` | no | `@playwright/mcp --no-sandbox --isolated` | Arguments for the above. `--isolated` gives each session a throwaway browser profile so multiple agent clients (VS Code + Cursor + Claude Code) don't fight over a shared `SingletonLock`. |
| `JDC_TRACE` | no | `0` | `1` writes snapshot traces to `JDC_TRACE_DIR` for debugging. |
| `JDC_TRACE_DIR` | no | `traces/` | Where traces land. |
| `JDC_PRIVACY_FAIL_OPEN` | no | `0` | Debug-only escape hatch for shield errors (see above). |

¹ Not required if `JDC_BYPASS=1`.

---

## Troubleshooting

**"config.missing_api_key" at startup** → Set `JDC_API_KEY` or create `~/.jdcodec/config.json`. Or run with `JDC_BYPASS=1` if you just want the privacy shield locally.

**"upstream.start_failed"** → The connector couldn't spawn Playwright MCP. Check that `npx @playwright/mcp --no-sandbox --isolated` works standalone; most issues are first-run Playwright browser downloads.

**Agent hangs for a long time on the first request** → Expected on a cold session. The cloud service warms in a couple of seconds; subsequent snapshots in the same session are sub-second. If it persists past ~10s per snapshot, check network connectivity to `api.jdcodec.com`.

**`reduction` is negative or small on the first snapshot** → Expected. The first snapshot in a new session is a full reference; subsequent snapshots compress against it. The session-wide reduction (shown when the session closes) is the meaningful number.

**Agent behaves differently with the connector than without** → Email `hello@jdcodec.com` with a trace (set `JDC_TRACE=1` and attach the latest file from `traces/`). We fix these as blocking.

---

## Getting help

One inbox for everything:

**`hello@jdcodec.com`** — alpha access, API keys, billing, bug reports, feature requests, security reports.

A public issue tracker, status page, and community forum will accompany the upcoming source-available release.

---

## Licence and scope

The connector binary published on npm is licensed for direct use. The cloud compression service is proprietary. Your snapshots are processed under the data-handling summary above.
