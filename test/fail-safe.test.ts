import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  redact,
  JdcPrivacyEngineError,
  loadRuleset,
  resetRulesetCacheForTests,
  setLoggerForTests,
} from "../src/privacy/index.js";
import type { Logger, LogEvent } from "../src/privacy/log.js";

interface CapturedEvent {
  level: string;
  event: string;
  [k: string]: unknown;
}

function makeCaptureLogger(): { logger: Logger; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  const logger: Logger = {
    emit(e) {
      events.push({ ...e } as CapturedEvent);
      void {} as LogEvent;
    },
  };
  return { logger, events };
}

describe("privacy shield — fail-safe", () => {
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
        throw new Error("synthetic rule failure for testing");
      },
      configurable: true,
    });
    sabotaged = true;
  }

  it("throws JdcPrivacyEngineError when the engine fails (default fail-closed)", () => {
    const { logger, events } = makeCaptureLogger();
    setLoggerForTests(logger);

    sabotageRuleset();

    expect(() => redact("jane@example.com")).toThrow(JdcPrivacyEngineError);

    const critical = events.find((e) => e.event === "privacy.engine.fail_closed");
    expect(critical, "expected fail_closed log").toBeDefined();
    expect(critical!.level).toBe("critical");
    expect(critical!.fail_mode).toBe("closed");
  });

  it("returns input unchanged when JDC_PRIVACY_FAIL_OPEN=1 and emits a critical log", () => {
    const { logger, events } = makeCaptureLogger();
    setLoggerForTests(logger);

    sabotageRuleset();

    process.env.JDC_PRIVACY_FAIL_OPEN = "1";

    const out = redact("call me at (415) 555-0123");
    expect(out.snapshotYaml).toBe("call me at (415) 555-0123");
    expect(out.redactionStats).toEqual({});

    const critical = events.find((e) => e.event === "privacy.engine.fail_open");
    expect(critical, "expected fail_open log").toBeDefined();
    expect(critical!.level).toBe("critical");
    expect(critical!.fail_mode).toBe("open");
  });

  it("the thrown error carries a stable code and no PII/rule detail", () => {
    const { logger } = makeCaptureLogger();
    setLoggerForTests(logger);
    sabotageRuleset();

    try {
      redact("secret password 4111-1111-1111-1111 jane@example.org");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JdcPrivacyEngineError);
      const e = err as JdcPrivacyEngineError;
      expect(e.code).toBe("privacy_engine_failure");
      expect(e.message).not.toMatch(/4111|5555|jane|example|password/i);
      expect(e.message).not.toMatch(/CC_VISA|EMAIL|PHONE|regex/i);
    }
  });
});
