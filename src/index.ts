#!/usr/bin/env node
/**
 * JD Codec connector CLI — local MCP proxy that wraps Playwright MCP, applies
 * the on-device Privacy Shield, and forwards snapshots to the cloud codec.
 *
 * Config:
 *   - JDC_API_KEY (env) or ~/.jdcodec/config.json `api_key` (file) — required unless JDC_BYPASS=1.
 *   - JDC_BYPASS=1 — skip cloud codec, return the already-redacted snapshot. Privacy Shield remains mandatory.
 *   - JDC_CLOUD_URL — override cloud endpoint (default https://api.jdcodec.com).
 *   - JDC_REGION — Cloudflare DO location hint (wnam|enam|sam|weur|eeur|apac|oc|afr|me).
 *   - JDC_LLM_PROVIDER — downstream LLM provider the agent calls (`anthropic`|`openai`|`gemini`).
 *     Optional. When set, the connector forwards it with every snapshot so the cloud's
 *     tokenizer picks the matching family; when unset, the cloud falls back to an
 *     approximate tokenizer and the usage row records that fact explicitly.
 *   - JDC_LLM_MODEL — optional model identifier (e.g. `claude-sonnet-4-6`, `gpt-4o`,
 *     `gemini-2.5-pro`). Refines tokenizer-version selection when a provider supports
 *     multiple. Ignored unless `JDC_LLM_PROVIDER` is also set.
 *   - JDC_PLAYWRIGHT_CMD / JDC_PLAYWRIGHT_ARGS — override the upstream MCP server command.
 *   - JDC_PRIVACY_FAIL_OPEN=1 — debug-only escape hatch; emits a critical log.
 *   - JDC_TRACE=1 — debug-only; appends per-match redaction span detail (rule, offsets, raw value)
 *     to ${JDC_TRACE_DIR}/spans-<sessionId>.jsonl. Default off; raw values are PII by definition,
 *     so trace files stay local to the developer's machine and must not be committed or shared.
 *   - JDC_TRACE_DIR — directory for span JSONL files when JDC_TRACE=1 (default: ./traces).
 */

import { loadConfig } from "./config/env.js";
import { CloudClient } from "./cloud/client.js";
import {
  isHelpFlag,
  isOnboardingCommand,
  isVersionFlag,
  printHelp,
  printVersion,
  runOnboarding,
} from "./onboarding/index.js";
import { makeStderrLogger } from "./proxy/log.js";
import { startProxy } from "./proxy/server.js";
import { UpstreamSession } from "./proxy/upstream.js";
import { checkForUpdate, formatVerdict } from "./onboarding/update-check.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];

  // Onboarding subcommands (start / login / audit) run a one-shot
  // interactive flow and exit. They never reach the MCP proxy path,
  // so stdout is free for human-readable output and the proxy's stdio
  // protocol is unaffected. Anything else (including no args) falls
  // through to the proxy below — invoking `jdcodec` with no arguments
  // continues to launch the MCP stdio proxy.
  if (isOnboardingCommand(first)) {
    const code = await runOnboarding(args);
    process.exit(code);
  }
  if (isHelpFlag(first)) {
    printHelp();
    process.exit(0);
  }
  if (isVersionFlag(first)) {
    // Read the cloud endpoint from config so a JDC_CLOUD_URL override is
    // visible without a separate command. No API key required — the
    // endpoint string itself is non-sensitive.
    printVersion(loadConfig().cloudUrl);
    process.exit(0);
  }

  const log = makeStderrLogger();
  const config = loadConfig();

  // Degraded-mode startup: missing key is no longer fatal. The MCP
  // protocol gives every client a window to start servers + register
  // tools at session boot; a server that exits before that window
  // closes is silently dropped from every client (Claude Code, the
  // Claude VS Code extension, Cursor, Windsurf, VS Code Copilot, etc.)
  // — spec-level behaviour, not client-specific. We instead start, log
  // a clear warning, and gate cloud-requiring tools at call time so
  // the agent surfaces an actionable error inside its own UI on the
  // first compression attempt.
  if (!config.apiKey && !config.bypass) {
    log.warn("config.no_api_key", {
      hint: "Connector starting in degraded mode. Snapshot tools will return auth_required until a key is configured. Run `jdcodec start` to register, then save the issued bearer to ~/.jdcodec/config.json (or set JDC_API_KEY). Run `jdcodec doctor` for a full diagnostic.",
    });
  }

  const cloud = config.apiKey && !config.bypass
    ? new CloudClient({
      apiKey: config.apiKey,
      baseUrl: config.cloudUrl,
      region: config.region,
    })
    : null;

  const upstream = new UpstreamSession();

  try {
    const tools = await upstream.start({
      command: config.playwrightCmd,
      args: config.playwrightArgs,
    });
    log.info("upstream.ready", {
      tool_count: tools.length,
      command: config.playwrightCmd,
    });
  } catch (err) {
    log.error("upstream.start_failed", { message: (err as Error)?.message ?? "unknown" });
    process.exit(3);
  }

  if (config.traceEnabled) {
    log.warn("trace.enabled", {
      dir: config.traceDir,
      hint: "JDC_TRACE=1 — writing raw matched values (PII) to disk. Local-only debug aid; do not commit or share trace files.",
    });
  }

  // Surface the agent-LLM binding once at startup. Three branches:
  //  - configured: info line confirming the provider (+ model). Helps
  //    customers verify their env wired up correctly.
  //  - typo / unrecognised provider: explicit warn so a fat-fingered
  //    value doesn't silently downgrade to approximate counts.
  //  - unset: silent. Approximate counts are the documented default.
  if (config.agentLlm) {
    log.info("config.agent_llm", {
      provider: config.agentLlm.provider,
      ...(config.agentLlm.model ? { model: config.agentLlm.model } : {}),
    });
  } else {
    const raw = process.env.JDC_LLM_PROVIDER?.trim();
    if (raw && raw.length > 0) {
      log.warn("config.agent_llm_invalid", {
        raw,
        hint: "JDC_LLM_PROVIDER must be one of: anthropic, openai, gemini. Falling back to approximate token accounting.",
      });
    }
  }

  // Fire-and-forget npm-registry update check. Never blocks startup;
  // cached for 24h. A surfaced "outdated" verdict is a stderr warn line
  // so MCP-hosted agents see it but stdio (JSON-RPC) stays clean.
  void checkForUpdate()
    .then((verdict) => {
      if (verdict.state === "outdated") {
        log.warn("connector.update_available", {
          current: verdict.current,
          latest: verdict.latest,
          hint: formatVerdict(verdict),
        });
      }
    })
    .catch(() => undefined);

  const proxy = await startProxy({
    upstream,
    cloud,
    bypass: config.bypass,
    log,
    ...(config.traceEnabled ? { trace: { dir: config.traceDir } } : {}),
    ...(config.agentLlm !== undefined ? { agentLlm: config.agentLlm } : {}),
  });

  // SHUTDOWN_HARD_TIMEOUT_MS bounds the connector's exit. The SDK's
  // StdioClientTransport.close() already cascades stdin-end → SIGTERM → SIGKILL
  // with 2s gates, totalling ~4s worst-case. The hard timeout here is a backstop
  // so a hung child can never pin the connector indefinitely; orphaning the
  // grandchildren is preferable to a stuck parent that blocks the next session.
  const SHUTDOWN_HARD_TIMEOUT_MS = 6000;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown", { signal });
    const hardExit = setTimeout(() => {
      log.error("shutdown.timeout", { signal, timeout_ms: SHUTDOWN_HARD_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS);
    hardExit.unref();
    try {
      await proxy.close();
    } catch {
      // best-effort
    }
    try {
      await upstream.close();
    } catch {
      // best-effort
    }
    clearTimeout(hardExit);
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGHUP", () => { void shutdown("SIGHUP"); });
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({
      level: "error",
      event: "jdcodec-connector.fatal",
      timestamp: new Date().toISOString(),
      message: (err as Error)?.message ?? "unknown",
    }) + "\n",
  );
  process.exit(1);
});
