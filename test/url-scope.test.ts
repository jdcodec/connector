import { describe, it, expect } from "vitest";
import { redact } from "../src/privacy/index.js";

describe("privacy shield — URL scope", () => {
  it("redacts PII in the URL path", () => {
    const out = redact(
      { snapshotYaml: "", url: "https://app.example.com/users/jane@example.org/profile" },
      { scope: "url" },
    );
    expect(out.url).toContain("{{REDACTED_EMAIL}}");
    expect(out.url).not.toContain("jane@example.org");
    expect(out.redactionStats.EMAIL).toBe(1);
  });

  it("redacts PII in the URL query", () => {
    const out = redact(
      {
        snapshotYaml: "",
        url: "https://app.example.com/search?phone=%2B14155550123&name=alice",
      },
      { scope: "url" },
    );
    expect(out.url).toContain("{{REDACTED_PHONE}}");
    expect(out.url).not.toContain("14155550123");
  });

  it("leaves the URL fragment untouched", () => {
    const out = redact(
      {
        snapshotYaml: "",
        url: "https://app.example.com/track?email=jane@example.org#ref=jane@example.org",
      },
      { scope: "url" },
    );
    // Fragment is preserved verbatim (including any PII-looking text) because fragments
    // are client-only state and never reach the server.
    expect(out.url).toContain("#ref=jane@example.org");
    // Query-side email IS redacted.
    const beforeFragment = out.url!.split("#")[0];
    expect(beforeFragment).toContain("{{REDACTED_EMAIL}}");
    expect(beforeFragment).not.toContain("jane@example.org");
  });

  it("scans body+url by default (scope='both')", () => {
    const out = redact({
      snapshotYaml: "Contact jane@example.org",
      url: "https://app.example.com/u/bob@example.org",
    });
    expect(out.snapshotYaml).toContain("{{REDACTED_EMAIL}}");
    expect(out.url).toContain("{{REDACTED_EMAIL}}");
    expect(out.redactionStats.EMAIL).toBeGreaterThanOrEqual(2);
  });

  it("scope='body' leaves URL untouched", () => {
    const input = {
      snapshotYaml: "Contact jane@example.org",
      url: "https://app.example.com/u/bob@example.org",
    };
    const out = redact(input, { scope: "body" });
    expect(out.snapshotYaml).toContain("{{REDACTED_EMAIL}}");
    expect(out.url).toBe(input.url);
  });

  it("scope='url' leaves snapshot body untouched", () => {
    const input = {
      snapshotYaml: "Contact jane@example.org",
      url: "https://app.example.com/u/bob@example.org",
    };
    const out = redact(input, { scope: "url" });
    expect(out.snapshotYaml).toBe(input.snapshotYaml);
    expect(out.url).toContain("{{REDACTED_EMAIL}}");
  });

  it("redacts a bare non-URL string via body scan", () => {
    const out = redact("email: jane@example.org");
    expect(out.snapshotYaml).toBe("email: {{REDACTED_EMAIL}}");
    expect(out.url).toBeUndefined();
  });
});
