import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  redact,
  JdcPrivacyEngineError,
  loadRuleset,
  resetRulesetCacheForTests,
  setLoggerForTests,
} from "../src/privacy/index.js";
import type { Logger } from "../src/privacy/log.js";

// Synthetic PII corpus seeded for audit. If any of these values appears in a log line,
// in an error message, in the thrown error, or in the `redaction_stats` object, the test
// fails.
const PII_CORPUS = {
  email: "seed-audit-12345@secret.example",
  phone: "+1-415-555-0199",
  cc: "4532015112830366", // Luhn-valid Visa
  ssn: "123-45-6789",
  jwt: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdWRpdCJ9.secretsig",
};

const SNAPSHOT = [
  `email: "${PII_CORPUS.email}"`,
  `phone: "${PII_CORPUS.phone}"`,
  `cc: "${PII_CORPUS.cc}"`,
  `ssn: "${PII_CORPUS.ssn}"`,
  `auth: "${PII_CORPUS.jwt}"`,
].join("\n");

const RULE_NAMES_SAMPLE = [
  "CC_VISA",
  "CC_MASTERCARD",
  "EMAIL_RFC5322_PRAGMATIC",
  "PHONE_US",
  "SSN_US",
  "BEARER_JWT",
  "API_KEY_GOOGLE",
  "PHONE_INTL_FALLBACK",
];

const REGEX_SOURCE_FRAGMENTS = [
  "[0-9]{12}",
  "(?:5[1-5]",
  "[A-Za-z0-9_-]{8,1024}",
];

interface CapturedEvent {
  level: string;
  event: string;
  [k: string]: unknown;
}

function captureLogs(): { logger: Logger; events: CapturedEvent[]; raw: string[] } {
  const events: CapturedEvent[] = [];
  const raw: string[] = [];
  const logger: Logger = {
    emit(e) {
      events.push({ ...e } as CapturedEvent);
      raw.push(JSON.stringify(e));
    },
  };
  return { logger, events, raw };
}

function assertNoLeakInString(haystack: string, context: string): void {
  for (const [k, v] of Object.entries(PII_CORPUS)) {
    expect(
      haystack.includes(v),
      `${context}: PII value '${k}' leaked in string`,
    ).toBe(false);
  }
  for (const name of RULE_NAMES_SAMPLE) {
    expect(
      haystack.includes(name),
      `${context}: rule name '${name}' leaked`,
    ).toBe(false);
  }
  for (const frag of REGEX_SOURCE_FRAGMENTS) {
    expect(
      haystack.includes(frag),
      `${context}: regex fragment '${frag}' leaked`,
    ).toBe(false);
  }
}

describe("Rule 0 containment + PII-in-logs audit", () => {
  let originalEnv: string | undefined;
  let sabotaged = false;

  beforeEach(() => {
    originalEnv = process.env.JDC_PRIVACY_FAIL_OPEN;
    delete process.env.JDC_PRIVACY_FAIL_OPEN;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.JDC_PRIVACY_FAIL_OPEN;
    else process.env.JDC_PRIVACY_FAIL_OPEN = originalEnv;
    if (sabotaged) {
      resetRulesetCacheForTests();
      sabotaged = false;
    }
    setLoggerForTests(null);
  });

  function sabotageRuleset(): void {
    const rs = loadRuleset();
    const firstRule = rs.rules[0];
    Object.defineProperty(firstRule, "regex", {
      get(): RegExp {
        // Intentional sentinel in the error message; we assert it does NOT leak out.
        throw new Error(
          `rule ${firstRule.name} failed on value ${PII_CORPUS.email} matching regex ${firstRule.replacementToken}`,
        );
      },
      configurable: true,
    });
    sabotaged = true;
  }

  it("success path: no PII, rule names, or regex source appear in logs", () => {
    const { logger, raw } = captureLogs();
    setLoggerForTests(logger);

    const out = redact(SNAPSHOT);

    // Engine redacted PII — no values in the output either
    for (const v of Object.values(PII_CORPUS)) {
      expect(out.snapshotYaml.includes(v), `output leaks PII '${v}'`).toBe(false);
    }
    // redactionStats is category → non-negative int only (contract §4.2 shape)
    for (const [k, v] of Object.entries(out.redactionStats)) {
      expect(typeof k).toBe("string");
      expect(Number.isInteger(v), `stats count for ${k} must be integer`).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    // No logs expected on success path
    for (const line of raw) assertNoLeakInString(line, "success log");
  });

  it("fail-closed error path: thrown error leaks nothing (even when inner error carries PII)", () => {
    const { logger, raw } = captureLogs();
    setLoggerForTests(logger);
    sabotageRuleset();

    let caught: unknown;
    try {
      redact(SNAPSHOT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JdcPrivacyEngineError);
    const asErr = caught as Error;
    assertNoLeakInString(asErr.message, "thrown error message");
    assertNoLeakInString(asErr.stack ?? "", "thrown error stack");

    for (const line of raw) assertNoLeakInString(line, "fail-closed log");
  });

  it("fail-open escape hatch: critical log leaks nothing", () => {
    const { logger, raw } = captureLogs();
    setLoggerForTests(logger);
    sabotageRuleset();

    process.env.JDC_PRIVACY_FAIL_OPEN = "1";

    const out = redact(SNAPSHOT);
    expect(out.snapshotYaml).toBe(SNAPSHOT);

    for (const line of raw) assertNoLeakInString(line, "fail-open log");
    const critical = raw.find((l) => l.includes("privacy.engine.fail_open"));
    expect(critical, "expected a critical fail_open log").toBeDefined();
  });

  it("redaction_stats is category-counts only (contract §4.2 shape)", () => {
    const out = redact(SNAPSHOT);
    const stats = out.redactionStats;
    for (const [category, count] of Object.entries(stats)) {
      expect(typeof count).toBe("number");
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
      // Category keys must be short tokens (like "EMAIL", "CC"), not values or regex.
      expect(category.length).toBeLessThanOrEqual(32);
      expect(category).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
