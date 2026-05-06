import { scanString } from "./engine.js";
import { loadRuleset } from "./ruleset.js";
import { emit } from "./log.js";
import { JdcPrivacyEngineError } from "./errors.js";
import type {
  RedactInput,
  RedactOptions,
  RedactResult,
  RedactSpan,
  RedactionStats,
} from "./types.js";

export { JdcPrivacyEngineError } from "./errors.js";
export type {
  RedactInput,
  RedactOptions,
  RedactResult,
  RedactSpan,
  RedactionStats,
  RedactScope,
} from "./types.js";
export { loadRuleset, resetRulesetCacheForTests } from "./ruleset.js";
export { setLoggerForTests } from "./log.js";

export function redact(input: RedactInput | string, options: RedactOptions = {}): RedactResult {
  const scope = options.scope ?? "both";
  const normalizedInput: RedactInput = typeof input === "string"
    ? { snapshotYaml: input }
    : { ...input };

  try {
    const rs = loadRuleset();
    const aggregateStats: RedactionStats = {};
    const captureSpans = options.captureSpans === true;
    const allSpans: RedactSpan[] | undefined = captureSpans ? [] : undefined;

    const shouldScanBody = scope === "body" || scope === "both";
    const shouldScanUrl = (scope === "url" || scope === "both") && normalizedInput.url !== undefined;

    let snapshotYaml = normalizedInput.snapshotYaml;
    if (shouldScanBody) {
      const bodyResult = scanString(normalizedInput.snapshotYaml, rs, { captureSpans });
      snapshotYaml = bodyResult.redacted;
      mergeStats(aggregateStats, bodyResult.stats);
      if (allSpans && bodyResult.spans) {
        for (const s of bodyResult.spans) allSpans.push({ ...s, source: "body" });
      }
    }

    let url: string | undefined = normalizedInput.url;
    if (shouldScanUrl && normalizedInput.url !== undefined) {
      const urlResult = redactUrl(normalizedInput.url, rs, captureSpans);
      url = urlResult.url;
      mergeStats(aggregateStats, urlResult.stats);
      if (allSpans && urlResult.spans) {
        for (const s of urlResult.spans) allSpans.push({ ...s, source: "url" });
      }
    }

    return {
      snapshotYaml,
      ...(url !== undefined ? { url } : {}),
      redactionStats: aggregateStats,
      ...(allSpans ? { spans: allSpans } : {}),
    };
  } catch (err) {
    return handleEngineFailure(err, normalizedInput);
  }
}

function redactUrl(
  rawUrl: string,
  rs: ReturnType<typeof loadRuleset>,
  captureSpans: boolean,
): { url: string; stats: RedactionStats; spans?: Array<{ ruleName: string; category: string; start: number; end: number; value: string }> } {
  const fragmentIdx = rawUrl.indexOf("#");
  const scannable = fragmentIdx >= 0 ? rawUrl.slice(0, fragmentIdx) : rawUrl;
  const fragment = fragmentIdx >= 0 ? rawUrl.slice(fragmentIdx) : "";
  const { redacted, stats, spans } = scanString(scannable, rs, { captureSpans });
  return { url: redacted + fragment, stats, ...(spans ? { spans } : {}) };
}

function mergeStats(into: RedactionStats, from: RedactionStats): void {
  for (const [k, v] of Object.entries(from)) {
    into[k] = (into[k] ?? 0) + v;
  }
}

function handleEngineFailure(err: unknown, input: RedactInput): RedactResult {
  if (process.env.JDC_PRIVACY_FAIL_OPEN === "1") {
    emit({
      level: "critical",
      event: "privacy.engine.fail_open",
      fail_mode: "open",
      reason: "engine_exception",
    });
    void err;
    return {
      snapshotYaml: input.snapshotYaml,
      ...(input.url !== undefined ? { url: input.url } : {}),
      redactionStats: {},
    };
  }
  emit({
    level: "critical",
    event: "privacy.engine.fail_closed",
    fail_mode: "closed",
    reason: "engine_exception",
  });
  throw new JdcPrivacyEngineError();
}
