import { describe, it, expect } from "vitest";
import { redact } from "../src/privacy/index.js";

// CI runners (e.g. GitHub Actions ubuntu-latest, shared-tenant) are 2-3× slower
// than typical dev machines for regex-heavy work. Apply a 4× multiplier when
// the CI env is set, leaving headroom for runner variance while still catching
// real perf regressions (anything 2× worse than the local baseline still fails CI).
const CI_FACTOR = process.env.CI ? 4 : 1;
const T_REALISTIC_MS = 100 * CI_FACTOR;
const T_DENSE_MS = 200 * CI_FACTOR;
const T_SMALL_MS = 30 * CI_FACTOR;

describe("privacy shield — performance", () => {
  it(`redacts a realistic 1 MB snapshot in <${T_REALISTIC_MS}ms (median of 5 runs)`, () => {
    // Realistic Playwright-MCP snapshot density: ~1 PII item per 2 KB. A real 1 MB
    // snapshot is mostly layout / button / ref metadata, with occasional PII values.
    const sparseBlock = buildBlock({ piiLines: 1, paddingLines: 40 });
    const snapshot = fillTo(sparseBlock, 1024 * 1024);

    // Warmup (primes JIT)
    redact(snapshot.slice(0, 64 * 1024));
    redact(snapshot.slice(0, 64 * 1024));

    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      redact(snapshot);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[2];

    expect(median, `median scan ${median.toFixed(1)} ms across 5 runs; all=${samples.map((n) => n.toFixed(1)).join(", ")}`).toBeLessThan(T_REALISTIC_MS);
  });

  it(`handles a PII-dense 1 MB snapshot within ${T_DENSE_MS}ms (sanity upper bound)`, () => {
    // Pathologically dense case: roughly 1 PII item per 50 chars. Not representative
    // of real DOM snapshots, included only to bound worst-case behaviour.
    const denseBlock = buildBlock({ piiLines: 3, paddingLines: 0 });
    const snapshot = fillTo(denseBlock, 1024 * 1024);

    redact(snapshot.slice(0, 16 * 1024));

    const t0 = performance.now();
    const out = redact(snapshot);
    const elapsed = performance.now() - t0;

    expect(Object.keys(out.redactionStats).length).toBeGreaterThan(0);
    expect(elapsed, `dense scan took ${elapsed.toFixed(1)} ms`).toBeLessThan(T_DENSE_MS);
  });

  it(`redacts a 200k-char snapshot in <${T_SMALL_MS}ms`, () => {
    const block = buildBlock({ piiLines: 3, paddingLines: 5 });
    const snapshot = fillTo(block, 200 * 1024);

    redact(snapshot.slice(0, 16 * 1024));

    const t0 = performance.now();
    redact(snapshot);
    const elapsed = performance.now() - t0;
    expect(elapsed, `200k scan took ${elapsed.toFixed(1)} ms`).toBeLessThan(T_SMALL_MS);
  });
});

function buildBlock(opts: { piiLines: number; paddingLines: number }): string {
  const piiMenu = [
    "  - textbox \"Email\" [ref=e2]: jane@example.org",
    "  - textbox \"Phone\" [ref=e3]: (415) 555-0123",
    "  - textbox \"Card\" [ref=e4]: 4111 1111 1111 1111",
  ];
  const padMenu = [
    "  - link \"Home\" [ref=e6]",
    "  - button \"Submit\" [ref=e7]",
    "  - heading \"Dashboard\" [ref=e8]",
    "  - generic \"status\" [ref=e9]",
    "  - region \"main\" [ref=e10]",
    "  - navigation [ref=e11]",
    "  - list [ref=e12]",
    "  - listitem [ref=e13]",
    "  - paragraph [ref=e14]: Welcome back.",
    "  - paragraph [ref=e15]: Recent activity shown below.",
  ];
  const lines: string[] = ["- heading \"Admin\" [ref=e1]"];
  for (let i = 0; i < opts.piiLines; i++) lines.push(piiMenu[i % piiMenu.length]);
  for (let i = 0; i < opts.paddingLines; i++) lines.push(padMenu[i % padMenu.length]);
  return lines.join("\n") + "\n";
}

function fillTo(block: string, size: number): string {
  let s = "";
  while (s.length < size) s += block;
  return s.slice(0, size);
}
