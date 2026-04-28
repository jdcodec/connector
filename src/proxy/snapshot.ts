import { redact, JdcPrivacyEngineError } from "../privacy/index.js";
import { CloudClient } from "../cloud/client.js";
import { CloudNetworkError, CloudRequestError } from "../cloud/errors.js";
import { SessionState } from "../session/state.js";
import { extractUrlFromResponse, joinSnapshotYaml, splitSnapshotYaml } from "./parse.js";

export interface HandleSnapshotDeps {
  cloud: CloudClient | null;
  session: SessionState;
  bypass: boolean;
  log?: Logger;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface HandleSnapshotResult {
  text: string;
  outcome:
    | "no_yaml"
    | "compressed"
    | "pass_through"
    | "bypass"
    | "cloud_unreachable"
    | "privacy_fail_closed";
  stats?: Record<string, unknown>;
}

/**
 * Hot-path handler for a `browser_snapshot` response from upstream Playwright MCP.
 *
 * 1. Extract the YAML + URL from the MCP text.
 * 2. Run Privacy Shield (mandatory) on snapshot body + url.
 * 3. If JDC_BYPASS or cloud is null: return the redacted snapshot unchanged.
 * 4. Otherwise POST to the cloud codec and splice compressed_output in.
 * 5. On any transient failure (network / 5xx / 429), degrade to the already-redacted
 *    snapshot with `codec_unreachable` log.
 *
 * Privacy Shield error handling:
 *   - Default fail-closed: returns `privacy_fail_closed` result — caller MUST block.
 *   - JDC_PRIVACY_FAIL_OPEN=1 is handled inside the engine; if it's set we get the
 *     original snapshot back with empty stats + a critical log already emitted.
 */
export async function handleSnapshot(
  mcpResponseText: string,
  deps: HandleSnapshotDeps,
): Promise<HandleSnapshotResult> {
  const { cloud, session, bypass } = deps;
  const log = deps.log ?? noopLogger;

  // Privacy Shield — mandatory on every path, including bypass + degraded.
  // We redact the ENTIRE MCP response text (not just the YAML block) so PII leaked
  // into surrounding framing ("Page URL: …", "Page Title: …", console tails, etc.)
  // never reaches the agent OR the cloud. The YAML block boundaries are preserved
  // because the ```yaml and ``` fences are non-PII tokens the engine won't rewrite.
  let redactedFull: string;
  let redactionStats: Record<string, number>;
  try {
    const result = redact(mcpResponseText);
    redactedFull = result.snapshotYaml;
    redactionStats = result.redactionStats;
  } catch (err) {
    if (err instanceof JdcPrivacyEngineError) {
      log.error("privacy.engine.block", { code: err.code });
      return {
        text: "[JDCodec: snapshot blocked by Privacy Shield. Set JDC_PRIVACY_FAIL_OPEN=1 to debug.]",
        outcome: "privacy_fail_closed",
      };
    }
    throw err;
  }

  const split = splitSnapshotYaml(redactedFull);
  if (!split) {
    // No YAML block — probably an upstream error response. Return the redacted
    // text (which is what the agent sees); no cloud POST needed.
    return { text: redactedFull, outcome: "no_yaml", stats: { redaction_stats: redactionStats } };
  }
  const redactedUrl = extractUrlFromResponse(redactedFull) ?? "";
  const redactedYaml = split.yamlText;
  const redactedText = redactedFull;

  // Bypass mode — codec skipped, redaction already done.
  if (bypass || cloud === null) {
    log.info("snapshot.bypass", {
      input_chars: redactedYaml.length,
      url: redactedUrl,
      redaction_stats: redactionStats,
    });
    return { text: redactedText, outcome: "bypass", stats: { redaction_stats: redactionStats } };
  }

  // Cloud POST.
  const snapshot = session.consume();
  let postResult;
  try {
    postResult = await cloud.postSnapshot({
      session_id: snapshot.sessionId,
      task_id: snapshot.taskId,
      step: snapshot.step,
      url: redactedUrl,
      snapshot_yaml: redactedYaml,
      client_redacted: true,
      redaction_stats: redactionStats,
    });
  } catch (err) {
    return degradedPath(err, redactedText, redactedYaml, redactionStats, session, log);
  }

  const { response, elapsedMs, requestId } = postResult;

  if (response.frame_type === "pass-through") {
    log.info("snapshot.pass_through", {
      step: snapshot.step,
      input_chars: redactedYaml.length,
      elapsed_ms: Math.round(elapsedMs),
      request_id: requestId,
      redaction_stats: redactionStats,
    });
    // Pass-through: server returns flag-only; connector reuses the already-redacted snapshot.
    return { text: redactedText, outcome: "pass_through", stats: { request_id: requestId } };
  }

  const compressed = response.compressed_output ?? "";
  log.info("snapshot.compressed", {
    step: snapshot.step,
    frame_type: response.frame_type,
    input_chars: response.compression_stats.input_chars,
    output_chars: response.compression_stats.output_chars,
    codec_ms: response.compression_stats.codec_ms,
    elapsed_ms: Math.round(elapsedMs),
    request_id: requestId,
    redaction_stats: redactionStats,
  });
  return {
    text: joinSnapshotYaml(split, compressed),
    outcome: "compressed",
    stats: { frame_type: response.frame_type, request_id: requestId },
  };
}

function degradedPath(
  err: unknown,
  redactedText: string,
  redactedYaml: string,
  redactionStats: Record<string, number>,
  session: SessionState,
  log: Logger,
): HandleSnapshotResult {
  if (err instanceof CloudRequestError) {
    if (err.code === "session_expired") {
      log.warn("snapshot.session_expired", { request_id: err.requestId });
      session.rotateSession();
      return { text: redactedText, outcome: "cloud_unreachable" };
    }
    if (err.code === "step_out_of_order") {
      log.warn("snapshot.step_out_of_order", { request_id: err.requestId });
      session.rotateTask();
      return { text: redactedText, outcome: "cloud_unreachable" };
    }
    if (err.isTransient) {
      log.warn("snapshot.codec_unreachable", {
        code: err.code,
        status: err.status,
        request_id: err.requestId,
      });
      return { text: redactedText, outcome: "cloud_unreachable" };
    }
    if (err.code === "payload_too_large") {
      log.warn("snapshot.payload_too_large", { request_id: err.requestId });
      return { text: redactedText, outcome: "cloud_unreachable" };
    }
    // Terminal auth / privacy-shield / version errors: surface as degraded path
    // since breaking the agent on a cloud-side error is worse UX than delivering
    // the already-redacted snapshot. Logged loudly for operator attention.
    log.error("snapshot.cloud_terminal_error", {
      code: err.code,
      status: err.status,
      request_id: err.requestId,
    });
    return { text: redactedText, outcome: "cloud_unreachable" };
  }
  if (err instanceof CloudNetworkError) {
    log.warn("snapshot.codec_unreachable", { cause: err.message });
    return { text: redactedText, outcome: "cloud_unreachable" };
  }
  // Unexpected — re-raise so upstream can surface.
  throw err;
}
