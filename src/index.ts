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
import { makeStderrLogger } from "./proxy/log.js";
import { startProxy } from "./proxy/server.js";
import { UpstreamSession } from "./proxy/upstream.js";

async function main(): Promise<void> {
  const log = makeStderrLogger();
  const config = loadConfig();

  if (!config.apiKey && !config.bypass) {
    log.error("config.missing_api_key", {
      hint: "Set JDC_API_KEY or write {\"api_key\": \"...\"} to ~/.jdcodec/config.json. Or run with JDC_BYPASS=1 for local debugging.",
    });
    process.exit(2);
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
