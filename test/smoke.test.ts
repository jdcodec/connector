import { describe, it, expect } from "vitest";
import { redact, loadRuleset } from "../src/privacy/index.js";

describe("privacy shield — smoke", () => {
  it("loads and compiles the ruleset", () => {
    const rs = loadRuleset();
    expect(rs.rules.length).toBeGreaterThan(20);
    expect(rs.version).toBe("2.2.0");
  });

  it("redacts a plain email", () => {
    const out = redact("Contact jane@example.com for details");
    expect(out.snapshotYaml).toBe("Contact {{REDACTED_EMAIL}} for details");
    expect(out.redactionStats).toEqual({ EMAIL: 1 });
  });

  it("leaves safe-list emails alone", () => {
    const out = redact("Reach out to user@example.com anytime");
    expect(out.snapshotYaml).toBe("Reach out to user@example.com anytime");
    expect(out.redactionStats).toEqual({});
  });

  it("redacts a consecutive Visa test PAN alone (no safe context)", () => {
    const out = redact("4111111111111111");
    expect(out.snapshotYaml).toBe("{{REDACTED_CC}}");
    expect(out.redactionStats).toEqual({ CC: 1 });
  });

  it("suppresses test-context CC test PAN", () => {
    const out = redact("Test card 4111111111111111");
    expect(out.snapshotYaml).toBe("Test card 4111111111111111");
    expect(out.redactionStats).toEqual({});
  });
});
