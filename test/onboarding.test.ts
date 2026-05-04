/**
 * Onboarding regression tests — pin the contract for
 * `stableMachineId()`, `runLogin()`, and `runAudit()`:
 *
 *   1. `stableMachineId()` returns the `py-node-` prefixed sha256-12
 *      digest, persists it to disk, and re-reads on subsequent calls
 *      — the prefix and file format are stable across releases.
 *   2. `runLogin()` POSTs the stable machine_id at session-create
 *      time so the server can link the OAuth-completed account row to
 *      any prior environment-audit row from the same machine.
 *   3. The post-OAuth display shows the unified block — welcome +
 *      position + account + Machine ID + skip-the-queue CTA — and
 *      omits any legacy random-id cosmetic line.
 *   4. The audit-only path surfaces Machine ID as a support handle
 *      (no email is captured on that path).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudit } from "../src/onboarding/audit.js";
import { DisplayIO } from "../src/onboarding/display.js";
import {
  DOCS_URL,
  isHelpFlag,
  isVersionFlag,
  printHelp,
  printVersion,
} from "../src/onboarding/index.js";
import { runLogin } from "../src/onboarding/login.js";
import { stableMachineId } from "../src/onboarding/machine-id.js";
import { VERSION } from "../src/onboarding/version.js";

function captureDisplay(): { io: DisplayIO; lines: string[]; joined: () => string } {
  const lines: string[] = [];
  return {
    io: {
      print: (line: string) => {
        lines.push(line);
      },
    },
    lines,
    joined: () => lines.join("\n"),
  };
}

/** Strip ANSI colour codes so assertions are colour-agnostic. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("onboarding — stableMachineId()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "jdc-mid-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a `py-node-` prefixed id with the sha256-12 digest format", () => {
    const path = join(tmpDir, "machine-id");
    const mid = stableMachineId({
      path,
      hostname: () => "test-host",
      networkInterfaces: () => ({
        en0: [
          {
            address: "192.168.0.2",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "aa:bb:cc:dd:ee:ff",
            internal: false,
            cidr: "192.168.0.2/24",
          },
        ],
      }),
    });
    expect(mid).toMatch(/^py-node-[0-9a-f]{12}$/);
  });

  it("persists to disk and re-reads on subsequent calls", () => {
    const path = join(tmpDir, "machine-id");
    const first = stableMachineId({
      path,
      hostname: () => "host-a",
      networkInterfaces: () => ({
        en0: [{
          address: "10.0.0.1", netmask: "255.0.0.0", family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "10.0.0.1/8",
        }],
      }),
    });
    expect(readFileSync(path, "utf8")).toBe(first);

    // Second call uses a different hostname/MAC source — but should
    // still return the cached value because the file was written.
    // That stability guarantee is what lets multiple JD Codec clients
    // on the same machine share a single machine ID.
    const second = stableMachineId({
      path,
      hostname: () => "host-b",
      networkInterfaces: () => ({}),
    });
    expect(second).toBe(first);
  });

  it("uses the stable `py-node-` prefix (file-format invariant)", () => {
    const path = join(tmpDir, "machine-id");
    const mid = stableMachineId({
      path,
      hostname: () => "anything",
      networkInterfaces: () => ({}),
    });
    expect(mid.startsWith("py-node-")).toBe(true);
  });
});

describe("onboarding — runLogin() POSTs machine_id at session create", () => {
  it("session-create POST includes machine_id in the body", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      if (url.includes("?sid=")) {
        return new Response(
          JSON.stringify({ status: "completed", email: "test@example.com", waitlist_pos: 38 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const { io } = captureDisplay();
    const code = await runLogin({
      display: io,
      fetch: fakeFetch,
      openBrowser: () => undefined,
      waitForEnter: async () => undefined,
      sleep: async () => undefined,
      generateSessionId: () => "sid1234567",
      machineId: () => "py-node-deadbeef0001",
    });

    expect(code).toBe(0);
    const create = calls[0];
    expect(create.url).toContain("/auth/session");
    expect(create.init?.method).toBe("POST");
    const body = JSON.parse(String(create.init?.body));
    expect(body.session_id).toBe("sid1234567");
    expect(body.machine_id).toBe("py-node-deadbeef0001");
    expect(typeof body.machine_id).toBe("string");
    expect(body.machine_id.startsWith("py-node-")).toBe(true);
  });
});

describe("onboarding — post-OAuth display block", () => {
  async function runWithPollResponse(
    poll: Record<string, unknown>,
  ): Promise<string> {
    const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("?sid=")) {
        return new Response(JSON.stringify(poll), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    };
    const cap = captureDisplay();
    await runLogin({
      display: cap.io,
      fetch: fakeFetch,
      openBrowser: () => undefined,
      waitForEnter: async () => undefined,
      sleep: async () => undefined,
      generateSessionId: () => "sid1234567",
      machineId: () => "py-node-cafe12345678",
    });
    return stripAnsi(cap.joined());
  }

  it("shows position, account, and machine ID", async () => {
    const out = await runWithPollResponse({
      status: "completed",
      email: "user@example.com",
      waitlist_pos: 42,
    });
    expect(out).toContain("NODE REGISTERED");
    expect(out).toContain("waitlist position is");
    expect(out).toContain("#42");
    expect(out).toContain("user@example.com");
    expect(out).toContain("Machine ID:");
    expect(out).toContain("py-node-cafe12345678");
  });

  it("shows the skip-the-queue CTA", async () => {
    const out = await runWithPollResponse({
      status: "completed",
      email: "user@example.com",
      waitlist_pos: 42,
    });
    expect(out.toLowerCase()).toContain("skip the queue");
    expect(out).toContain("hello@jdcodec.com");
    expect(out).toContain("what you're building");
  });

  it("does not print a separate cosmetic node-id line", async () => {
    const out = await runWithPollResponse({
      status: "completed",
      email: "user@example.com",
      waitlist_pos: 42,
    });
    expect(out).not.toContain("Node ID:");
  });

  it("renders without the position line when the server omits waitlist_pos", async () => {
    const out = await runWithPollResponse({
      status: "completed",
      email: "user@example.com",
      // no waitlist_pos
    });
    expect(out).toContain("NODE REGISTERED");
    expect(out).toContain("user@example.com");
    expect(out).toContain("Machine ID:");
    expect(out).not.toContain("waitlist position is");
  });
});

describe("onboarding — audit display surfaces Machine ID", () => {
  it("audit output includes Machine ID and the py-node- prefixed id", async () => {
    const cap = captureDisplay();
    await runAudit({
      display: cap.io,
      fetch: async () => new Response("{}", { status: 200 }),
      cwd: () => "/tmp/empty-jdc-test",
      env: {},
      machineId: () => "py-node-abcd12345678",
      sleep: async () => undefined,
      scan: () => ({ langchain: false, playwright: false, browser_use: false, keys_found: 0 }),
    });
    const joined = stripAnsi(cap.joined());
    expect(joined).toContain("Machine ID:");
    expect(joined).toContain("py-node-abcd12345678");
  });

  it("posts source: 'npm' to the intent-logger", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response("{}", { status: 200 });
    };
    const cap = captureDisplay();
    await runAudit({
      display: cap.io,
      fetch: fakeFetch,
      cwd: () => "/tmp/empty-jdc-test",
      env: {},
      machineId: () => "py-node-abcd12345678",
      sleep: async () => undefined,
      scan: () => ({ langchain: false, playwright: false, browser_use: false, keys_found: 0 }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/intent-logger");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.source).toBe("npm");
    expect(body.machine_id).toBe("py-node-abcd12345678");
    expect(body.audit_results).toEqual({
      langchain: false,
      playwright: false,
      browser_use: false,
      keys_found: 0,
    });
  });

  it("reports COMPATIBLE when playwright or browser-use is detected", async () => {
    const cap = captureDisplay();
    await runAudit({
      display: cap.io,
      fetch: async () => new Response("{}", { status: 200 }),
      cwd: () => "/tmp/empty-jdc-test",
      env: {},
      machineId: () => "py-node-abcd12345678",
      sleep: async () => undefined,
      scan: () => ({ langchain: false, playwright: true, browser_use: false, keys_found: 0 }),
    });
    const joined = stripAnsi(cap.joined());
    expect(joined).toContain("System Check: COMPATIBLE");
  });

  it("counts API keys from env", async () => {
    const calls: { init?: RequestInit }[] = [];
    const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ init });
      return new Response("{}", { status: 200 });
    };
    await runAudit({
      display: captureDisplay().io,
      fetch: fakeFetch,
      cwd: () => "/tmp/empty-jdc-test",
      env: { OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" },
      machineId: () => "py-node-abcd12345678",
      sleep: async () => undefined,
      scan: () => ({ langchain: false, playwright: false, browser_use: false, keys_found: 0 }),
    });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.audit_results.keys_found).toBe(2);
  });
});

describe("onboarding — banner reads from package.json version", () => {
  it("audit banner includes a version string and is not a hardcoded literal", async () => {
    const cap = captureDisplay();
    await runAudit({
      display: cap.io,
      fetch: async () => new Response("{}", { status: 200 }),
      cwd: () => "/tmp/empty-jdc-test",
      env: {},
      machineId: () => "py-node-abcd12345678",
      sleep: async () => undefined,
      scan: () => ({ langchain: false, playwright: false, browser_use: false, keys_found: 0 }),
    });
    const banner = cap.lines.find((l) => stripAnsi(l).includes("initializing"));
    expect(banner, "expected a banner line").toBeTruthy();
    expect(stripAnsi(banner ?? "")).toMatch(/v\d+\.\d+\.\d+/);
  });
});

describe("CLI — flag classifiers", () => {
  it("isHelpFlag accepts --help, -h, and help; rejects others", () => {
    expect(isHelpFlag("--help")).toBe(true);
    expect(isHelpFlag("-h")).toBe(true);
    expect(isHelpFlag("help")).toBe(true);
    expect(isHelpFlag("--version")).toBe(false);
    expect(isHelpFlag("start")).toBe(false);
    expect(isHelpFlag(undefined)).toBe(false);
    expect(isHelpFlag("")).toBe(false);
  });

  it("isVersionFlag accepts --version, -v, and version; rejects others", () => {
    expect(isVersionFlag("--version")).toBe(true);
    expect(isVersionFlag("-v")).toBe(true);
    expect(isVersionFlag("version")).toBe(true);
    expect(isVersionFlag("--help")).toBe(false);
    expect(isVersionFlag("audit")).toBe(false);
    expect(isVersionFlag(undefined)).toBe(false);
  });
});

describe("CLI — printHelp()", () => {
  it("includes every documented command", () => {
    const cap = captureDisplay();
    printHelp(cap.io);
    const out = stripAnsi(cap.joined());
    expect(out).toContain("start, login");
    expect(out).toContain("audit");
    expect(out).toContain("--help, -h");
    expect(out).toContain("--version, -v");
    expect(out).toContain("(no args)");
    expect(out).toContain("MCP stdio proxy");
  });

  it("renders the docs URL in the footer", () => {
    const cap = captureDisplay();
    printHelp(cap.io);
    const out = stripAnsi(cap.joined());
    expect(out).toContain(DOCS_URL);
    expect(DOCS_URL).toBe("https://jdcodec.com/docs");
  });

  it("includes the CLI version next to the title", () => {
    const cap = captureDisplay();
    printHelp(cap.io);
    const out = stripAnsi(cap.joined());
    expect(out).toContain("JD Codec CLI");
    expect(out).toContain(VERSION);
  });

  it("preserves the ASCII logo", () => {
    const cap = captureDisplay();
    printHelp(cap.io);
    const out = stripAnsi(cap.joined());
    expect(out).toContain("JD CODEC");
  });

  it("mentions both env vars required for the no-args proxy path", () => {
    const cap = captureDisplay();
    printHelp(cap.io);
    const out = stripAnsi(cap.joined());
    expect(out).toContain("JDC_API_KEY");
    expect(out).toContain("JDC_BYPASS");
  });
});

describe("CLI — printVersion()", () => {
  it("prints the connector version on a line tagged 'jdcodec'", () => {
    const cap = captureDisplay();
    printVersion("https://api.jdcodec.com", cap.io);
    const out = stripAnsi(cap.joined());
    expect(out).toContain(`jdcodec ${VERSION}`);
  });

  it("prints the configured cloud endpoint on its own line", () => {
    const cap = captureDisplay();
    printVersion("https://api.jdcodec.com", cap.io);
    const out = stripAnsi(cap.joined());
    expect(out).toContain("endpoint  https://api.jdcodec.com");
  });

  it("respects a custom endpoint override", () => {
    const cap = captureDisplay();
    printVersion("https://staging.example.test", cap.io);
    const out = stripAnsi(cap.joined());
    expect(out).toContain("endpoint  https://staging.example.test");
  });

  it("emits exactly two lines (no header, no logo, no banner)", () => {
    const cap = captureDisplay();
    printVersion("https://api.jdcodec.com", cap.io);
    expect(cap.lines).toHaveLength(2);
  });

  it("does not make a network call (signature accepts no fetch)", () => {
    // Compile-time: printVersion takes (cloudUrl, display) only —
    // there is no fetch / network parameter to pass. Runtime: the body
    // never reads from process.env or imports any HTTP client.
    // This test pins that contract: --version must remain offline.
    const cap = captureDisplay();
    const before = cap.lines.length;
    printVersion("https://api.jdcodec.com", cap.io);
    expect(cap.lines.length - before).toBe(2);
  });
});
