import type { Logger } from "./snapshot.js";

/**
 * Structured logger that writes one JSON line per event to stderr.
 * MCP uses stdout for the protocol; all connector-side logs MUST go to stderr.
 *
 * Never log snapshot YAML, URL path beyond the redacted form, API keys, or raw
 * bearer tokens. Category counts (redaction_stats) are fine per contract §4.2.
 */
export function makeStderrLogger(prefix = "jdcodec-connector"): Logger {
  const write = (level: string, event: string, fields?: Record<string, unknown>): void => {
    const line = {
      level,
      event: `${prefix}.${event}`,
      timestamp: new Date().toISOString(),
      ...fields,
    };
    process.stderr.write(JSON.stringify(line) + "\n");
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
