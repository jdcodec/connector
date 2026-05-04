/**
 * Doctor probe regression tests — pin the contract for each individual
 * probe AND the orchestrator's exit-code logic. Probes are designed to
 * be unit-testable in isolation: each takes its IO/config as parameters,
 * so we can drive every branch (ok/warn/fail) deterministically without
 * spawning subprocesses, mounting tmpdirs, or hitting the network.
 *
 * One integration test at the bottom drives `runDoctor()` end-to-end
 * with all dependencies mocked, to confirm the orchestrator wires
 * probes together correctly and computes the right exit code.
 */

import { describe, expect, it } from "vitest";

import { DisplayIO } from "../src/onboarding/display.js";
import {
  CheckResult,
  CheckStatus,
  probeCloudAuth,
  probeConfigFile,
  probeConnectorVersion,
  probeGlobalNpmConflict,
  probeKeyShape,
  probeMultipleBinaries,
  probeNodeVersion,
  probeNpmGlobalPath,
  probeNpx,
  probePlaywrightMcp,
  renderCheck,
  runDoctor,
  SpawnResult,
  summariseExitCode,
} from "../src/onboarding/doctor.js";

function captureDisplay(): { io: DisplayIO; lines: string[]; joined: () => string } {
  const lines: string[] = [];
  return {
    io: { print: (line: string) => { lines.push(line); } },
    lines,
    joined: () => lines.join("\n"),
  };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const VALID_KEY = "jdck_0123456789abcdef.thisisthesecrethalfwithlotsofentropy";

// ---------------------------------------------------------------------
// probeNodeVersion
// ---------------------------------------------------------------------

describe("probeNodeVersion", () => {
  it("ok on Node 22", () => {
    const r = probeNodeVersion("22.5.1");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("v22.5.1");
  });
  it("ok on Node 24", () => {
    expect(probeNodeVersion("24.0.0").status).toBe("ok");
  });
  it("fail on Node 20", () => {
    const r = probeNodeVersion("20.10.0");
    expect(r.status).toBe("fail");
    expect(r.hint).toContain("Node");
    expect(r.docsLink).toBeTruthy();
  });
  it("fail on Node 18", () => {
    expect(probeNodeVersion("18.0.0").status).toBe("fail");
  });
  it("fail on garbage version string", () => {
    expect(probeNodeVersion("not-a-version").status).toBe("fail");
  });
});

// ---------------------------------------------------------------------
// probeNpx
// ---------------------------------------------------------------------

describe("probeNpx", () => {
  it("ok when which returns a path", () => {
    const r = probeNpx("/usr/local/bin/npx");
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("/usr/local/bin/npx");
  });
  it("fail when which returns null", () => {
    const r = probeNpx(null);
    expect(r.status).toBe("fail");
    expect(r.hint).toMatch(/npm/i);
  });
});

// ---------------------------------------------------------------------
// probePlaywrightMcp
// ---------------------------------------------------------------------

describe("probePlaywrightMcp", () => {
  async function fakeSpawn(result: SpawnResult): Promise<SpawnResult> {
    return result;
  }

  it("ok when subprocess exits 0", async () => {
    const r = await probePlaywrightMcp(() => fakeSpawn({ exitCode: 0, stdout: "", stderr: "" }));
    expect(r.status).toBe("ok");
  });
  it("warn when subprocess exits non-zero (lazy install allowed)", async () => {
    const r = await probePlaywrightMcp(() => fakeSpawn({ exitCode: 1, stdout: "", stderr: "" }));
    expect(r.status).toBe("warn");
    expect(r.hint).toMatch(/lazy-installed/i);
  });
  it("warn when timeout", async () => {
    const r = await probePlaywrightMcp(() => fakeSpawn({ exitCode: null, stdout: "", stderr: "", timedOut: true }));
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/timed out/i);
  });
  it("warn when spawn throws", async () => {
    const r = await probePlaywrightMcp(() => Promise.reject(new Error("ENOENT")));
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/ENOENT/);
  });
});

// ---------------------------------------------------------------------
// probeConnectorVersion
// ---------------------------------------------------------------------

describe("probeConnectorVersion", () => {
  it("always ok and includes a 'jdcodec' prefix + version", () => {
    const r = probeConnectorVersion();
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/^jdcodec /);
    expect(r.detail).toMatch(/\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------
// probeConfigFile
// ---------------------------------------------------------------------

describe("probeConfigFile", () => {
  it("ok when JDC_API_KEY env is set (no file needed)", () => {
    const o = probeConfigFile("/missing", VALID_KEY, () => null);
    expect(o.result.status).toBe("ok");
    expect(o.source).toBe("env");
    expect(o.apiKey).toBe(VALID_KEY);
  });

  it("fail when no env and no file", () => {
    const o = probeConfigFile("/missing", undefined, () => null);
    expect(o.result.status).toBe("fail");
    expect(o.apiKey).toBeNull();
  });

  it("fail when file is malformed JSON", () => {
    const o = probeConfigFile("/x.json", undefined, () => "not json {");
    expect(o.result.status).toBe("fail");
    expect(o.result.detail).toMatch(/not valid JSON/);
  });

  it("fail when file is a JSON array (not object)", () => {
    const o = probeConfigFile("/x.json", undefined, () => "[1,2,3]");
    expect(o.result.status).toBe("fail");
  });

  it("fail when api_key field is missing", () => {
    const o = probeConfigFile("/x.json", undefined, () => '{"other":"value"}');
    expect(o.result.status).toBe("fail");
    expect(o.result.detail).toMatch(/no api_key/);
  });

  it("fail when api_key is empty string", () => {
    const o = probeConfigFile("/x.json", undefined, () => '{"api_key":""}');
    expect(o.result.status).toBe("fail");
  });

  it("ok when api_key is present in file", () => {
    const o = probeConfigFile("/x.json", undefined, () => `{"api_key":"${VALID_KEY}"}`);
    expect(o.result.status).toBe("ok");
    expect(o.source).toBe("file");
    expect(o.apiKey).toBe(VALID_KEY);
  });

  it("does not leak the api_key value into the displayed detail", () => {
    const o = probeConfigFile("/x.json", undefined, () => `{"api_key":"${VALID_KEY}"}`);
    expect(o.result.detail).not.toContain(VALID_KEY);
    expect(o.result.detail).toContain(`length ${VALID_KEY.length}`);
  });

  it("env wins over file when both are set", () => {
    const envKey = "jdck_aaaa1111aaaa1111.envsecretkeyhere1234567890";
    const fileKey = `{"api_key":"${VALID_KEY}"}`;
    const o = probeConfigFile("/x.json", envKey, () => fileKey);
    expect(o.source).toBe("env");
    expect(o.apiKey).toBe(envKey);
  });

  it("trims whitespace on the env key", () => {
    const o = probeConfigFile("/missing", `   ${VALID_KEY}   `, () => null);
    expect(o.apiKey).toBe(VALID_KEY);
  });
});

// ---------------------------------------------------------------------
// probeKeyShape
// ---------------------------------------------------------------------

describe("probeKeyShape", () => {
  it("ok on a well-formed two-half key", () => {
    expect(probeKeyShape(VALID_KEY).status).toBe("ok");
  });

  it("fail when key is null", () => {
    expect(probeKeyShape(null).status).toBe("fail");
  });

  it("fail when prefix is wrong", () => {
    expect(probeKeyShape("jdc_0123456789abcdef.secrethere1234").status).toBe("fail");
    expect(probeKeyShape("sk-0123456789abcdef.secrethere1234").status).toBe("fail");
  });

  it("fail with a specific hint when only the public id is present", () => {
    const r = probeKeyShape("jdck_0123456789abcdef");
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/missing.*secret/i);
    expect(r.hint).toMatch(/dot/);
    expect(r.hint).toMatch(/secret/);
  });

  it("fail when id half is not 'jdck_' + 16 hex chars", () => {
    expect(probeKeyShape("jdck_xxxx.secret1234567890ab").status).toBe("fail");
    expect(probeKeyShape("jdck_short.secret1234567890ab").status).toBe("fail");
  });

  it("fail when secret half is too short", () => {
    expect(probeKeyShape("jdck_0123456789abcdef.short").status).toBe("fail");
  });

  it("does not echo the full key into the displayed detail", () => {
    const r = probeKeyShape(VALID_KEY);
    expect(r.detail).toContain("jdck_0123456789abcdef");
    expect(r.detail).not.toContain("thisisthesecrethalf");
    expect(r.detail).toMatch(/<secret-\d+-chars>/);
  });
});

// ---------------------------------------------------------------------
// probeCloudAuth
// ---------------------------------------------------------------------

describe("probeCloudAuth", () => {
  function makeFetch(
    status: number,
    body: object | null = null,
  ): typeof fetch {
    return (async () => {
      return new Response(body === null ? "{}" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  it("ok when cloud returns 400 malformed_request (auth passed, body failed)", async () => {
    const r = await probeCloudAuth({
      cloudUrl: "https://api.example.test",
      apiKey: VALID_KEY,
      fetchImpl: makeFetch(400, { error: { code: "malformed_request" } }),
      generateRequestId: () => "req-1",
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/accepted/i);
  });

  it("fail with auth_invalid when cloud returns 401 auth_invalid", async () => {
    const r = await probeCloudAuth({
      cloudUrl: "https://api.example.test",
      apiKey: VALID_KEY,
      fetchImpl: makeFetch(401, { error: { code: "auth_invalid" } }),
      generateRequestId: () => "req-1",
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("auth_invalid");
  });

  it("fail with auth_revoked specific hint when cloud returns 401 auth_revoked", async () => {
    const r = await probeCloudAuth({
      cloudUrl: "https://api.example.test",
      apiKey: VALID_KEY,
      fetchImpl: makeFetch(401, { error: { code: "auth_revoked" } }),
      generateRequestId: () => "req-1",
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("auth_revoked");
    expect(r.hint).toMatch(/revoked/i);
  });

  it("warn when cloud returns 503 (transient server issue)", async () => {
    const r = await probeCloudAuth({
      cloudUrl: "https://api.example.test",
      apiKey: VALID_KEY,
      fetchImpl: makeFetch(503, { error: { code: "codec_overloaded" } }),
      generateRequestId: () => "req-1",
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("503");
  });

  it("warn on network error (fetch throws non-AbortError)", async () => {
    const r = await probeCloudAuth({
      cloudUrl: "https://api.example.test",
      apiKey: VALID_KEY,
      fetchImpl: (() => Promise.reject(new TypeError("ECONNREFUSED"))) as typeof fetch,
      generateRequestId: () => "req-1",
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/network/i);
  });

  it("warn on timeout (AbortError)", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const r = await probeCloudAuth({
      cloudUrl: "https://api.example.test",
      apiKey: VALID_KEY,
      fetchImpl: (() => Promise.reject(abortErr)) as typeof fetch,
      generateRequestId: () => "req-1",
      timeoutMs: 100,
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/timeout/i);
  });

  it("fail when apiKey is null (skipped probe)", async () => {
    const r = await probeCloudAuth({
      cloudUrl: "https://api.example.test",
      apiKey: null,
      fetchImpl: makeFetch(200),
      generateRequestId: () => "req-1",
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/skipped/i);
  });

  it("ok when cloud returns 413 (auth passed, payload too large) — non-401 = bearer accepted", async () => {
    const r = await probeCloudAuth({
      cloudUrl: "https://api.example.test",
      apiKey: VALID_KEY,
      fetchImpl: makeFetch(413, { error: { code: "payload_too_large" } }),
      generateRequestId: () => "req-1",
    });
    expect(r.status).toBe("ok");
  });

  it("sends the bearer in the Authorization header", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch: typeof fetch = (async (input, init) => {
      calls.push({ url: input.toString(), init });
      return new Response('{"error":{"code":"malformed_request"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await probeCloudAuth({
      cloudUrl: "https://api.example.test",
      apiKey: VALID_KEY,
      fetchImpl: fakeFetch,
      generateRequestId: () => "req-xyz",
    });
    expect(calls).toHaveLength(1);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${VALID_KEY}`);
    expect(headers["X-JDC-API-Version"]).toBe("1");
    expect(headers["X-Request-Id"]).toBe("req-xyz");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].url).toBe("https://api.example.test/v1/snapshot");
  });

  it("strips a trailing slash from the cloud URL", async () => {
    const calls: { url: string }[] = [];
    const fakeFetch: typeof fetch = (async (input) => {
      calls.push({ url: input.toString() });
      return new Response('{"error":{"code":"malformed_request"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await probeCloudAuth({
      cloudUrl: "https://api.example.test///",
      apiKey: VALID_KEY,
      fetchImpl: fakeFetch,
      generateRequestId: () => "req-1",
    });
    expect(calls[0].url).toBe("https://api.example.test/v1/snapshot");
  });

  it("does not fall over when the response body is non-JSON", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    const r = await probeCloudAuth({
      cloudUrl: "https://api.example.test",
      apiKey: VALID_KEY,
      fetchImpl: fakeFetch,
      generateRequestId: () => "req-1",
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("502");
  });
});

// ---------------------------------------------------------------------
// probeNpmGlobalPath
// ---------------------------------------------------------------------

describe("probeNpmGlobalPath", () => {
  it("ok when /usr/local/bin is on PATH", () => {
    const r = probeNpmGlobalPath("/usr/bin:/usr/local/bin:/bin");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("/usr/local/bin");
  });
  it("ok when ~/.nvm/ is on PATH", () => {
    const r = probeNpmGlobalPath("/home/user/.nvm/versions/node/v22/bin");
    expect(r.status).toBe("ok");
  });
  it("ok when /opt/homebrew/bin is on PATH (Apple Silicon)", () => {
    const r = probeNpmGlobalPath("/opt/homebrew/bin:/usr/bin");
    expect(r.status).toBe("ok");
  });
  it("warn when none of the expected dirs are on PATH", () => {
    const r = probeNpmGlobalPath("/some/unrelated/path:/another");
    expect(r.status).toBe("warn");
    expect(r.hint).toMatch(/non-sudo/i);
  });
  it("warn on empty PATH", () => {
    expect(probeNpmGlobalPath("").status).toBe("warn");
  });
});

// ---------------------------------------------------------------------
// probeMultipleBinaries
// ---------------------------------------------------------------------

describe("probeMultipleBinaries", () => {
  it("ok when exactly one binary is on PATH", () => {
    const r = probeMultipleBinaries(["/usr/local/bin/jdcodec"]);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("/usr/local/bin/jdcodec");
  });

  it("ok and dedupes when PATH is duplicated", () => {
    const r = probeMultipleBinaries([
      "/Users/x/.local/bin/jdcodec",
      "/Users/x/.local/bin/jdcodec",
    ]);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/single binary/);
  });

  it("warn when two distinct binaries shadow each other (real failure mode)", () => {
    const r = probeMultipleBinaries([
      "/Users/x/.local/bin/jdcodec",
      "/Users/x/.npm-global/bin/jdcodec",
    ]);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/2 binaries/);
    expect(r.hint).toContain("/Users/x/.local/bin/jdcodec");
    expect(r.hint).toContain("/Users/x/.npm-global/bin/jdcodec");
    expect(r.hint).toMatch(/npm uninstall -g jdcodec/);
  });

  it("warn when no binary at all (degenerate — internally inconsistent)", () => {
    const r = probeMultipleBinaries([]);
    expect(r.status).toBe("warn");
  });

  it("trims whitespace and ignores empty lines from `which -a` output", () => {
    const r = probeMultipleBinaries(["  /a/jdcodec  ", "", "  /a/jdcodec"]);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("/a/jdcodec");
  });
});

// ---------------------------------------------------------------------
// probeGlobalNpmConflict
// ---------------------------------------------------------------------

describe("probeGlobalNpmConflict", () => {
  function fakeSpawn(stdout: string, opts: Partial<SpawnResult> = {}) {
    return async (): Promise<SpawnResult> => ({
      exitCode: 0,
      stdout,
      stderr: "",
      ...opts,
    });
  }

  it("ok when npm is not on PATH (skipped, no probe possible)", async () => {
    const r = await probeGlobalNpmConflict(null, fakeSpawn(""), "0.5.0");
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/npm not on PATH/);
  });

  it("ok when no global jdcodec is installed", async () => {
    const r = await probeGlobalNpmConflict(
      "/usr/local/bin/npm",
      fakeSpawn(JSON.stringify({ dependencies: { foo: { version: "1.0.0" } } })),
      "0.5.0",
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/no global/);
  });

  it("ok when global jdcodec matches running version", async () => {
    const r = await probeGlobalNpmConflict(
      "/usr/local/bin/npm",
      fakeSpawn(JSON.stringify({ dependencies: { jdcodec: { version: "0.5.0" } } })),
      "0.5.0",
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("0.5.0");
    expect(r.detail).toMatch(/matches/);
  });

  it("warn when global jdcodec is at a different version (the real failure mode)", async () => {
    const r = await probeGlobalNpmConflict(
      "/usr/local/bin/npm",
      fakeSpawn(JSON.stringify({ dependencies: { jdcodec: { version: "0.4.0" } } })),
      "0.5.0",
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("0.4.0");
    expect(r.detail).toContain("0.5.0");
    expect(r.hint).toMatch(/npm uninstall -g jdcodec/);
  });

  it("ok (silently) when npm ls output is unparseable", async () => {
    const r = await probeGlobalNpmConflict(
      "/usr/local/bin/npm",
      fakeSpawn("definitely not json"),
      "0.5.0",
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/unparseable/);
  });

  it("ok (silently) when npm ls timed out", async () => {
    const spawn = async (): Promise<SpawnResult> => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const r = await probeGlobalNpmConflict("/usr/local/bin/npm", spawn, "0.5.0");
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/no output/);
  });

  it("ok (silently) when spawn throws", async () => {
    const spawn = async (): Promise<SpawnResult> => { throw new Error("EACCES"); };
    const r = await probeGlobalNpmConflict("/usr/local/bin/npm", spawn, "0.5.0");
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/failed/);
  });

  it("warn when global entry exists but version is missing", async () => {
    const r = await probeGlobalNpmConflict(
      "/usr/local/bin/npm",
      fakeSpawn(JSON.stringify({ dependencies: { jdcodec: {} } })),
      "0.5.0",
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/version is unreadable/);
  });
});

// ---------------------------------------------------------------------
// renderCheck + summariseExitCode + runDoctor orchestrator
// ---------------------------------------------------------------------

describe("renderCheck", () => {
  it("prints a single line containing the badge, name, and detail", () => {
    const cap = captureDisplay();
    renderCheck({ name: "X", status: "ok", detail: "fine" }, cap.io);
    expect(stripAnsi(cap.lines[0])).toContain("[ ok ]");
    expect(stripAnsi(cap.lines[0])).toContain("X");
    expect(stripAnsi(cap.lines[0])).toContain("fine");
  });
  it("prints hint lines indented", () => {
    const cap = captureDisplay();
    renderCheck({
      name: "X",
      status: "fail",
      detail: "broken",
      hint: "fix line one\nfix line two",
    }, cap.io);
    expect(cap.lines).toHaveLength(3);
    expect(stripAnsi(cap.lines[1])).toMatch(/^\s+fix line one/);
    expect(stripAnsi(cap.lines[2])).toMatch(/^\s+fix line two/);
  });
  it("prints a docs link line when present", () => {
    const cap = captureDisplay();
    renderCheck({
      name: "X",
      status: "fail",
      detail: "broken",
      docsLink: "https://example.test/docs/x",
    }, cap.io);
    expect(stripAnsi(cap.lines[1])).toContain("https://example.test/docs/x");
  });
});

describe("summariseExitCode", () => {
  function r(status: CheckStatus): CheckResult {
    return { name: "x", status, detail: "" };
  }
  it("returns 0 when all ok", () => {
    expect(summariseExitCode([r("ok"), r("ok")])).toBe(0);
  });
  it("returns 0 when warns are present but no fails", () => {
    expect(summariseExitCode([r("ok"), r("warn"), r("warn")])).toBe(0);
  });
  it("returns 1 when any check failed", () => {
    expect(summariseExitCode([r("ok"), r("fail")])).toBe(1);
  });
  it("returns 0 on empty input (degenerate)", () => {
    expect(summariseExitCode([])).toBe(0);
  });
});

describe("runDoctor — orchestrator end-to-end", () => {
  it("returns 0 and prints a green summary when all probes pass", async () => {
    const cap = captureDisplay();
    const exitCode = await runDoctor({
      display: cap.io,
      processVersions: { node: "22.5.0" },
      pathEnv: "/usr/local/bin",
      which: () => "/usr/local/bin/npx",
      whichAll: () => ["/Users/x/.local/bin/jdcodec"],
      spawnAsync: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: () => null,
      apiKeyEnv: VALID_KEY,
      cloudUrl: "https://api.example.test",
      fetchImpl: (async () =>
        new Response('{"error":{"code":"malformed_request"}}', {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      generateRequestId: () => "req-1",
    });
    expect(exitCode).toBe(0);
    const out = stripAnsi(cap.joined());
    expect(out).toContain("All checks passed.");
    expect(out).toContain("Node version");
    expect(out).toContain("Cloud auth");
  });

  it("returns 1 and reports failures when key shape is bad", async () => {
    const cap = captureDisplay();
    const exitCode = await runDoctor({
      display: cap.io,
      processVersions: { node: "22.5.0" },
      pathEnv: "/usr/local/bin",
      which: () => "/usr/local/bin/npx",
      whichAll: () => ["/Users/x/.local/bin/jdcodec"],
      spawnAsync: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: () => null,
      apiKeyEnv: "jdck_0123456789abcdef", // id only, no secret half
      cloudUrl: "https://api.example.test",
      fetchImpl: (async () =>
        new Response("{}", { status: 200 })) as typeof fetch,
      generateRequestId: () => "req-1",
    });
    expect(exitCode).toBe(1);
    const out = stripAnsi(cap.joined());
    expect(out).toMatch(/failed/);
    expect(out).toMatch(/missing.*secret/i);
  });

  it("skips the cloud probe when key shape failed (no wasted round-trip)", async () => {
    const cap = captureDisplay();
    let fetchCalled = false;
    await runDoctor({
      display: cap.io,
      processVersions: { node: "22.5.0" },
      pathEnv: "/usr/local/bin",
      which: () => "/usr/local/bin/npx",
      whichAll: () => ["/Users/x/.local/bin/jdcodec"],
      spawnAsync: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: () => null,
      apiKeyEnv: "jdck_0123456789abcdef", // id only
      cloudUrl: "https://api.example.test",
      fetchImpl: (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      generateRequestId: () => "req-1",
    });
    expect(fetchCalled).toBe(false);
    expect(stripAnsi(cap.joined())).toMatch(/Cloud auth.*skipped/);
  });

  it("returns 1 when Node version is too old, even if everything else passes", async () => {
    const cap = captureDisplay();
    const exitCode = await runDoctor({
      display: cap.io,
      processVersions: { node: "18.0.0" },
      pathEnv: "/usr/local/bin",
      which: () => "/usr/local/bin/npx",
      whichAll: () => ["/Users/x/.local/bin/jdcodec"],
      spawnAsync: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: () => null,
      apiKeyEnv: VALID_KEY,
      cloudUrl: "https://api.example.test",
      fetchImpl: (async () =>
        new Response('{"error":{"code":"malformed_request"}}', {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      generateRequestId: () => "req-1",
    });
    expect(exitCode).toBe(1);
  });

  it("warnings alone do not fail the run (exit 0)", async () => {
    const cap = captureDisplay();
    const exitCode = await runDoctor({
      display: cap.io,
      processVersions: { node: "22.5.0" },
      pathEnv: "/random/path", // npm-global PATH probe will warn
      which: () => "/usr/local/bin/npx",
      spawnAsync: async () => ({ exitCode: 1, stdout: "", stderr: "" }), // playwright warns
      readFile: () => null,
      apiKeyEnv: VALID_KEY,
      cloudUrl: "https://api.example.test",
      fetchImpl: (async () =>
        new Response('{"error":{"code":"malformed_request"}}', {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      generateRequestId: () => "req-1",
    });
    expect(exitCode).toBe(0);
    expect(stripAnsi(cap.joined())).toMatch(/warning/);
  });

  it("prints the configured cloud endpoint in the header", async () => {
    const cap = captureDisplay();
    await runDoctor({
      display: cap.io,
      processVersions: { node: "22.5.0" },
      pathEnv: "/usr/local/bin",
      which: () => "/usr/local/bin/npx",
      whichAll: () => ["/Users/x/.local/bin/jdcodec"],
      spawnAsync: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: () => null,
      apiKeyEnv: VALID_KEY,
      cloudUrl: "https://staging.example.test",
      fetchImpl: (async () =>
        new Response('{"error":{"code":"malformed_request"}}', {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      generateRequestId: () => "req-1",
    });
    expect(stripAnsi(cap.joined())).toContain("https://staging.example.test");
  });

  it("never prints the bearer value to the display", async () => {
    const cap = captureDisplay();
    await runDoctor({
      display: cap.io,
      processVersions: { node: "22.5.0" },
      pathEnv: "/usr/local/bin",
      which: () => "/usr/local/bin/npx",
      whichAll: () => ["/Users/x/.local/bin/jdcodec"],
      spawnAsync: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: () => `{"api_key":"${VALID_KEY}"}`,
      configPath: "/fake/config.json",
      apiKeyEnv: undefined,
      cloudUrl: "https://api.example.test",
      fetchImpl: (async () =>
        new Response('{"error":{"code":"malformed_request"}}', {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      generateRequestId: () => "req-1",
    });
    const out = stripAnsi(cap.joined());
    expect(out).toContain("jdck_0123456789abcdef"); // id half is fine, public
    expect(out).not.toContain("thisisthesecrethalfwithlotsofentropy"); // secret half must not leak
  });

  it("surfaces the global-npm-conflict scenario end-to-end (the real customer failure mode)", async () => {
    // Simulates: customer has pipx jdcodec at /Users/x/.local/bin/jdcodec
    // AND a stale npm install -g jdcodec@0.4.0 at /Users/x/.npm-global/bin/jdcodec.
    // Doctor should warn on both Probe 9 (multi-binary) and Probe 10 (version mismatch).
    const cap = captureDisplay();
    const exitCode = await runDoctor({
      display: cap.io,
      processVersions: { node: "22.5.0" },
      pathEnv: "/Users/x/.local/bin:/Users/x/.npm-global/bin",
      which: (cmd) => {
        if (cmd === "npx") return "/Users/x/.npm-global/bin/npx";
        if (cmd === "npm") return "/Users/x/.npm-global/bin/npm";
        return null;
      },
      whichAll: () => [
        "/Users/x/.local/bin/jdcodec",
        "/Users/x/.npm-global/bin/jdcodec",
      ],
      spawnAsync: async (cmd, args) => {
        if (cmd === "npm" && args[0] === "ls") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              dependencies: { jdcodec: { version: "0.4.0" } },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readFile: () => null,
      apiKeyEnv: VALID_KEY,
      cloudUrl: "https://api.example.test",
      fetchImpl: (async () =>
        new Response('{"error":{"code":"malformed_request"}}', {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      generateRequestId: () => "req-1",
    });
    // Warnings only — exit 0 (warnings don't fail the run).
    expect(exitCode).toBe(0);
    const out = stripAnsi(cap.joined());
    // Probe 9 fires
    expect(out).toMatch(/jdcodec on PATH.*shadow/);
    expect(out).toContain("/Users/x/.local/bin/jdcodec");
    expect(out).toContain("/Users/x/.npm-global/bin/jdcodec");
    // Probe 10 fires
    expect(out).toMatch(/Global npm install.*0\.4\.0/);
    expect(out).toMatch(/npm uninstall -g jdcodec/);
    // Summary acknowledges warnings
    expect(out).toMatch(/warning/);
  });
});
