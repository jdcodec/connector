import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "../src/privacy/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(__dirname, "fixtures", "realistic-admin-page.snapshot.txt"),
  "utf8",
);

/**
 * Synthetic positive-regression fixture for the v2.3.0 tier policy.
 *
 * The pre-fix corpus tested rules with bare-shape positives ("123456789"
 * must redact as TFN). The v2.3.0 policy explicitly does not redact such
 * inputs — bare shape without context is now a non-match. This test
 * exists to confirm that **realistic admin-page content where PII sits
 * next to its label still redacts**, which is what real customer pages
 * look like.
 *
 * Each section of the fixture pairs a PII class with the context cue the
 * matching booster keyword expects:
 *
 *   passport: GBR9012345               → PASSPORT booster (passport)
 *   NHS: 943 476 5919                  → NHS booster
 *   Tax File Number: 123 456 782       → TFN booster (tax file)
 *   SSN: 123-45-6789                   → SSN booster
 *   ABN: 51 824 753 556                → ABN booster
 *   ACN: 004 028 077                   → ACN booster
 *   Credit card: 4111 1111 1111 1111   → CC booster (credit / card)
 *   IBAN: GB82 WEST 1234 5698 7654 32  → IBAN booster
 *   Routing: 021 000 021               → IBAN booster (routing)
 *   Server ... client connect 192.168.1.42 → NETWORK booster
 *   Authorization: Basic dXNl...        → AUTH booster
 *
 * If any of these stops redacting, a real customer page would also stop
 * redacting it, which is the regression we cannot ship.
 */
describe("realistic admin page — positive regression (v2.3.0 tier policy)", () => {
  const result = redact(FIXTURE);
  const stats = result.redactionStats;
  const out = result.snapshotYaml;

  it("redacts passport number (PASSPORT booster)", () => {
    expect(out).toContain("{{REDACTED_PASSPORT}}");
    expect(out).not.toContain("A12345678");
  });

  it("redacts NHS number (NHS booster)", () => {
    expect(out).toContain("{{REDACTED_NHS}}");
    expect(out).not.toContain("943 476 5919");
  });

  it("redacts TFN (TFN booster, real checksum-valid value)", () => {
    expect(out).toContain("{{REDACTED_TFN}}");
    expect(out).not.toContain("123 456 782");
  });

  it("redacts SSN (SSN booster)", () => {
    expect(out).toContain("{{REDACTED_SSN}}");
    expect(out).not.toContain("123-45-6789");
  });

  it("redacts ABN (ABN booster)", () => {
    expect(out).toContain("{{REDACTED_ABN}}");
    expect(out).not.toContain("51 824 753 556");
  });

  it("redacts ACN (ACN booster, real checksum-valid value)", () => {
    expect(out).toContain("{{REDACTED_ACN}}");
    expect(out).not.toContain("004 028 077");
  });

  it("redacts credit card (CC booster, Luhn-valid test Visa)", () => {
    expect(out).toContain("{{REDACTED_CC}}");
    expect(out).not.toContain("4111 1111 1111 1111");
  });

  it("redacts IBAN (IBAN booster)", () => {
    expect(out).toContain("{{REDACTED_IBAN}}");
    expect(out).not.toContain("GB82 WEST 1234 5698 7654 32");
  });

  it("redacts ABA routing number (IBAN booster catches 'routing')", () => {
    // ROUTING_US_ABA emits replacement_token: IP per ruleset (legacy token name).
    // The point of this test is the rule fires at all when context is present.
    expect((stats.IP ?? 0)).toBeGreaterThanOrEqual(1);
    expect(out).not.toContain("021000021");
  });

  it("redacts IPv4 (NETWORK booster: 'Server', 'client', 'connect')", () => {
    expect(out).toContain("{{REDACTED_IP}}");
    expect(out).not.toContain("192.168.1.42");
  });

  it("redacts Basic auth header (AUTH booster: 'Authorization')", () => {
    expect(out).toContain("{{REDACTED_TOKEN}}");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA==");
  });

  it("redacts the email and phone (high-confidence, no booster needed)", () => {
    expect(out).toContain("{{REDACTED_EMAIL}}");
    expect(out).not.toContain("jane.customer@example.com");
    expect(out).toContain("{{REDACTED_PHONE}}");
    expect(out).not.toContain("(555) 123-4567");
  });

  it("redacts DOB (DOB booster: 'DOB:', 'birth')", () => {
    expect(out).toContain("{{REDACTED_DOB}}");
    expect(out).not.toContain("1985-04-12");
  });

  it("emits at least one redaction in every category covered by the fixture", () => {
    const expected = [
      "PASSPORT",
      "NHS",
      "TFN",
      "SSN",
      "ABN",
      "ACN",
      "CC",
      "IBAN",
      "IP",
      "TOKEN",
      "EMAIL",
      "PHONE",
      "DOB",
    ];
    for (const cat of expected) {
      expect(stats[cat] ?? 0, `expected ≥1 redaction in category ${cat}`).toBeGreaterThanOrEqual(1);
    }
  });
});
