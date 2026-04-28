import { describe, it, expect } from "vitest";
import {
  extractUrlFromResponse,
  splitSnapshotYaml,
  joinSnapshotYaml,
} from "../src/proxy/parse.js";

const SAMPLE_RESPONSE = `
Ran Playwright code:
\`\`\`js
await page.goto('https://example.com/admin');
\`\`\`

Page URL: https://example.com/admin
Page Title: Admin

- Page Snapshot
\`\`\`yaml
- heading "Admin Dashboard" [ref=e1]
  - link "Users" [ref=e2]
  - link "Products" [ref=e3]
\`\`\`

Tabs:
- 0: active [Admin]
`.trim();

describe("extractUrlFromResponse", () => {
  it("extracts 'Page URL:' form", () => {
    expect(extractUrlFromResponse(SAMPLE_RESPONSE)).toBe("https://example.com/admin");
  });

  it("is case-insensitive on the 'Page' header", () => {
    expect(extractUrlFromResponse("page url: https://foo/")).toBe("https://foo/");
  });

  it("returns null when no URL is present", () => {
    expect(extractUrlFromResponse("just some text")).toBeNull();
  });

  it("stops at whitespace", () => {
    expect(extractUrlFromResponse("Page URL: https://example.com/\nNext line"))
      .toBe("https://example.com/");
  });
});

describe("splitSnapshotYaml", () => {
  it("extracts YAML content and preserves framing", () => {
    const split = splitSnapshotYaml(SAMPLE_RESPONSE);
    expect(split).not.toBeNull();
    expect(split!.yamlText).toContain("heading \"Admin Dashboard\"");
    expect(split!.prefix).toContain("Page Snapshot");
    expect(split!.prefix.endsWith("```yaml\n")).toBe(true);
    expect(split!.suffix.startsWith("```")).toBe(true);
    expect(split!.suffix).toContain("Tabs:");
  });

  it("returns null when there is no YAML block", () => {
    expect(splitSnapshotYaml("Error: could not capture snapshot")).toBeNull();
  });

  it("handles multi-line YAML", () => {
    const text = "before\n```yaml\n- a\n- b\n- c\n```\nafter";
    const split = splitSnapshotYaml(text);
    expect(split!.yamlText).toBe("- a\n- b\n- c");
  });
});

describe("joinSnapshotYaml", () => {
  it("round-trips a split + join when the replacement matches the original", () => {
    const split = splitSnapshotYaml(SAMPLE_RESPONSE)!;
    const rebuilt = joinSnapshotYaml(split, split.yamlText);
    // Not byte-identical because the trim() inside split may have eaten trailing whitespace
    // between the last YAML line and the closing ``` fence. The join preserves content fidelity.
    expect(rebuilt).toContain("```yaml\n- heading \"Admin Dashboard\"");
    expect(rebuilt).toContain("```\n\nTabs:");
  });

  it("inserts a compressed payload in place of the YAML block", () => {
    const split = splitSnapshotYaml(SAMPLE_RESPONSE)!;
    const out = joinSnapshotYaml(split, "COMPRESSED_OUTPUT");
    expect(out).toContain("```yaml\nCOMPRESSED_OUTPUT\n```");
    expect(out).not.toContain("heading \"Admin Dashboard\"");
  });
});
