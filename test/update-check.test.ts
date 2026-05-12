/**
 * Unit tests for the npm-registry update check. Each test routes the
 * cache through a per-test tmp path so they cannot bleed into the real
 * `~/.jdcodec/version-check.json` or into one another. afterAll cleans
 * the tmp dir; the test fixture has its own gitignore entry as a
 * belt-and-braces measure if a killed run leaves files behind.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  REGISTRY_URL,
  checkForUpdate,
  compareVersions,
  formatVerdict,
  type UpdateVerdict,
} from "../src/onboarding/update-check.js";

let tmpRoot: string;
let cachePath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "jdcodec-update-check-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Per-test cache file inside the shared tmp root. Each test gets a
  // unique filename so concurrent vitest workers don't fight.
  cachePath = join(tmpRoot, `cache-${Math.random().toString(36).slice(2)}.json`);
});

function stubFetch(
  handler: (input: RequestInfo | URL) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: RequestInfo | URL) => handler(input)) as typeof fetch;
}

describe("compareVersions", () => {
  it("orders semver triples correctly", () => {
    expect(compareVersions("0.5.9", "0.6.0")).toBe(-1);
    expect(compareVersions("0.6.0", "0.5.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1); // numeric, not lex
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });

  it("treats pre-release suffixes as lower than the plain release", () => {
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
  });
});

describe("checkForUpdate — registry happy path", () => {
  it("returns 'outdated' when registry latest > current", async () => {
    const verdict = await checkForUpdate({
      currentVersion: "0.5.9",
      cachePath,
      fetchImpl: stubFetch(
        () => new Response(JSON.stringify({ version: "0.6.0" }), { status: 200 }),
      ),
    });
    expect(verdict.state).toBe("outdated");
    if (verdict.state === "outdated") {
      expect(verdict.current).toBe("0.5.9");
      expect(verdict.latest).toBe("0.6.0");
    }
  });

  it("returns 'current' when versions match", async () => {
    const verdict = await checkForUpdate({
      currentVersion: "0.6.0",
      cachePath,
      fetchImpl: stubFetch(
        () => new Response(JSON.stringify({ version: "0.6.0" }), { status: 200 }),
      ),
    });
    expect(verdict.state).toBe("current");
  });

  it("hits the published registry URL", async () => {
    let observed: string | null = null;
    await checkForUpdate({
      currentVersion: "0.5.9",
      cachePath,
      fetchImpl: stubFetch((input) => {
        observed = input.toString();
        return new Response(JSON.stringify({ version: "0.6.0" }), { status: 200 });
      }),
    });
    expect(observed).toBe(REGISTRY_URL);
  });
});

describe("checkForUpdate — failure paths degrade silently", () => {
  it("returns 'unknown' on registry 5xx (never throws)", async () => {
    const verdict = await checkForUpdate({
      currentVersion: "0.5.9",
      cachePath,
      fetchImpl: stubFetch(() => new Response("oops", { status: 503 })),
    });
    expect(verdict.state).toBe("unknown");
  });

  it("returns 'unknown' on malformed registry body", async () => {
    const verdict = await checkForUpdate({
      currentVersion: "0.5.9",
      cachePath,
      fetchImpl: stubFetch(
        () => new Response(JSON.stringify({ not_a_version: "0.6.0" }), { status: 200 }),
      ),
    });
    expect(verdict.state).toBe("unknown");
  });

  it("returns 'unknown' on network error", async () => {
    const verdict = await checkForUpdate({
      currentVersion: "0.5.9",
      cachePath,
      fetchImpl: stubFetch(() => {
        throw new Error("ENETDOWN");
      }),
    });
    expect(verdict.state).toBe("unknown");
  });
});

describe("checkForUpdate — caching", () => {
  it("serves the cached verdict on a fresh hit without re-fetching", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls++;
      return new Response(JSON.stringify({ version: "0.6.0" }), { status: 200 });
    });
    // Prime.
    await checkForUpdate({
      currentVersion: "0.5.9",
      cachePath,
      fetchImpl,
    });
    // Hit cache.
    const v2 = await checkForUpdate({
      currentVersion: "0.5.9",
      cachePath,
      fetchImpl,
    });
    expect(calls).toBe(1);
    expect(v2.state).toBe("outdated");
  });

  it("re-fetches when the cache has expired", async () => {
    const fetchImpl = stubFetch(
      () => new Response(JSON.stringify({ version: "0.6.0" }), { status: 200 }),
    );
    // Prime with `now=0` so the 24h TTL fires before our second call.
    await checkForUpdate({
      currentVersion: "0.5.9",
      cachePath,
      fetchImpl,
      now: () => 0,
    });
    const v2 = await checkForUpdate({
      currentVersion: "0.5.9",
      cachePath,
      fetchImpl,
      // 25h later — past the 24h success TTL.
      now: () => 25 * 60 * 60 * 1000,
    });
    expect(v2.state).toBe("outdated");
    // Cache is rewritten with the new check timestamp; assert the file
    // exists rather than introspecting internals.
    const persisted = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(persisted.checkedAtMs).toBe(25 * 60 * 60 * 1000);
  });
});

describe("formatVerdict", () => {
  it("emits a customer-readable line for each state", () => {
    const out: UpdateVerdict = { state: "outdated", current: "0.5.9", latest: "0.6.0" };
    expect(formatVerdict(out)).toMatch(/newer jdcodec.*0\.5\.9.*0\.6\.0/i);
    const cur: UpdateVerdict = { state: "current", current: "0.6.0", latest: "0.6.0" };
    expect(formatVerdict(cur)).toMatch(/up to date.*0\.6\.0/i);
    const unk: UpdateVerdict = { state: "unknown", current: "0.5.9", reason: "ENETDOWN" };
    expect(formatVerdict(unk)).toMatch(/skipped.*ENETDOWN/);
  });
});
