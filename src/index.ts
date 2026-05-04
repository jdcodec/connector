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
 *   - JDC_PLAYWRIGHT_CMD / JDC_PLAYWRIGHT_ARGS — override the upstream MCP server command.
 *   - JDC_PRIVACY_FAIL_OPEN=1 — debug-only escape hatch; emits a critical log.
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

  const proxy = await startProxy({
    upstream,
    cloud,
    bypass: config.bypass,
    log,
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info("shutdown", { signal });
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
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
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
