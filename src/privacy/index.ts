import { scanString } from "./engine.js";
import { loadRuleset } from "./ruleset.js";
import { emit } from "./log.js";
import { JdcPrivacyEngineError } from "./errors.js";
import type {
  RedactInput,
  RedactOptions,
  RedactResult,
  RedactionStats,
} from "./types.js";

export { JdcPrivacyEngineError } from "./errors.js";
export type {
  RedactInput,
  RedactOptions,
  RedactResult,
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

    const shouldScanBody = scope === "body" || scope === "both";
    const shouldScanUrl = (scope === "url" || scope === "both") && normalizedInput.url !== undefined;

    let snapshotYaml = normalizedInput.snapshotYaml;
    if (shouldScanBody) {
      const bodyResult = scanString(normalizedInput.snapshotYaml, rs);
      snapshotYaml = bodyResult.redacted;
      mergeStats(aggregateStats, bodyResult.stats);
    }

    let url: string | undefined = normalizedInput.url;
    if (shouldScanUrl && normalizedInput.url !== undefined) {
      const urlResult = redactUrl(normalizedInput.url, rs);
      url = urlResult.url;
      mergeStats(aggregateStats, urlResult.stats);
    }

    return {
      snapshotYaml,
      ...(url !== undefined ? { url } : {}),
      redactionStats: aggregateStats,
    };
  } catch (err) {
    return handleEngineFailure(err, normalizedInput);
  }
}

function redactUrl(
  rawUrl: string,
  rs: ReturnType<typeof loadRuleset>,
): { url: string; stats: RedactionStats } {
  const fragmentIdx = rawUrl.indexOf("#");
  const scannable = fragmentIdx >= 0 ? rawUrl.slice(0, fragmentIdx) : rawUrl;
  const fragment = fragmentIdx >= 0 ? rawUrl.slice(fragmentIdx) : "";
  const { redacted, stats } = scanString(scannable, rs);
  return { url: redacted + fragment, stats };
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
