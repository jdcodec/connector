/**
 * Setup helper regression tests — pin the contract for
 * `jdcodec setup <client> [--no-connector] [--no-docs]`.
 *
 * Two MCP servers (connector, docs) × four targets (claude-code,
 * cursor, windsurf, vscode) plus one alias (claude-vscode → claude-code)
 * × default-both-with-opt-out flags.
 *
 * No real subprocess is spawned — `which` and `spawnAsync` are
 * injected, so we can drive every branch deterministically.
 */

import { describe, expect, it } from "vitest";

import { DisplayIO } from "../src/onboarding/display.js";
import {
  CLIENTS,
  isClient,
  parseSetupArgs,
  printSetupHelp,
  runSetup,
  SERVERS,
  SpawnResult,
} from "../src/onboarding/setup.js";

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

interface SpawnCall {
  cmd: string;
  args: string[];
}

function mockSpawn(result: SpawnResult): {
  spawnAsync: (cmd: string, args: string[]) => Promise<SpawnResult>;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawnAsync: async (cmd, args) => {
      calls.push({ cmd, args });
      return result;
    },
  };
}

// ---------------------------------------------------------------------
// SERVERS — registry IS the contract
// ---------------------------------------------------------------------

describe("SERVERS registry", () => {
  it("connector server: stdio transport, command 'jdcodec', name 'jdcodec'", () => {
    const s = SERVERS.connector;
    expect(s.name).toBe("jdcodec");
    expect(s.label).toMatch(/connector/i);
    expect(s.transport).toBe("stdio");
    expect(s.command).toBe("jdcodec");
    expect(s.url).toBeUndefined();
    expect(s.manualDescription).toContain("command: jdcodec");
    expect(s.manualDescription).toMatch(/stdio/i);
  });

  it("docs server: http transport, url points at jdcodec.com/docs/mcp, name 'jdcodec-docs'", () => {
    const s = SERVERS.docs;
    expect(s.name).toBe("jdcodec-docs");
    expect(s.label).toMatch(/docs/i);
    expect(s.transport).toBe("http");
    expect(s.url).toBe("https://jdcodec.com/docs/mcp");
    expect(s.command).toBeUndefined();
    expect(s.manualDescription).toContain("https://jdcodec.com/docs/mcp");
    expect(s.manualDescription).toMatch(/http/i);
  });
});

// ---------------------------------------------------------------------
// CLIENTS — registry IS the contract for which IDEs we support
// ---------------------------------------------------------------------

describe("CLIENTS registry", () => {
  it("includes claude-code, claude-vscode, and vscode as CLI-driven clients", () => {
    const cli = Object.entries(CLIENTS).filter(([, c]) => c.kind === "cli");
    expect(cli.map(([k]) => k).sort()).toEqual(["claude-code", "claude-vscode", "vscode"]);
    expect(CLIENTS["claude-code"]).toMatchObject({ kind: "cli", cmd: "claude" });
    expect(CLIENTS["vscode"]).toMatchObject({ kind: "cli", cmd: "code" });
  });

  it("`claude-vscode` is an alias of `claude-code` (same spec object, no duplication)", () => {
    // Strict identity check — both keys point at the SAME ClientSpec
    // instance. If someone refactors to two separate objects, this
    // test fails immediately and surfaces the drift risk.
    expect(CLIENTS["claude-vscode"]).toBe(CLIENTS["claude-code"]);
  });

  it("includes cursor / windsurf as manual print-only clients", () => {
    const manual = Object.entries(CLIENTS).filter(([, c]) => c.kind === "manual");
    expect(manual.map(([k]) => k).sort()).toEqual(["cursor", "windsurf"]);
  });

  it("each manual client carries a configHint and a docsUrl", () => {
    for (const key of ["cursor", "windsurf"]) {
      const c = CLIENTS[key];
      expect(c.kind).toBe("manual");
      if (c.kind === "manual") {
        expect(c.configHint).toBeTruthy();
        expect(c.docsUrl).toMatch(/^https?:\/\//);
      }
    }
  });

  it("each CLI client provides buildArgs that yields the canonical add-args per server", () => {
    // Claude Code — positional args, stdio uses `-- <command>`,
    // http uses `--transport http <name> <url>`.
    const claude = CLIENTS["claude-code"];
    if (claude.kind !== "cli") throw new Error("claude-code should be a CLI client");
    expect(claude.buildArgs(SERVERS.connector)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "jdcodec",
      "--",
      "jdcodec",
    ]);
    expect(claude.buildArgs(SERVERS.docs)).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "jdcodec-docs",
      "https://jdcodec.com/docs/mcp",
    ]);

    // VS Code — wraps the server config in a `--add-mcp '{json}'` flag.
    // stdio: { name, command }; http: { name, type: "http", url }.
    const vscode = CLIENTS["vscode"];
    if (vscode.kind !== "cli") throw new Error("vscode should be a CLI client");
    const vsConnector = vscode.buildArgs(SERVERS.connector);
    expect(vsConnector[0]).toBe("--add-mcp");
    expect(JSON.parse(vsConnector[1])).toEqual({
      name: "jdcodec",
      command: "jdcodec",
    });
    const vsDocs = vscode.buildArgs(SERVERS.docs);
    expect(vsDocs[0]).toBe("--add-mcp");
    expect(JSON.parse(vsDocs[1])).toEqual({
      name: "jdcodec-docs",
      type: "http",
      url: "https://jdcodec.com/docs/mcp",
    });
  });
});

describe("isClient", () => {
  it("matches each registered client", () => {
    expect(isClient("claude-code")).toBe(true);
    expect(isClient("cursor")).toBe(true);
    expect(isClient("windsurf")).toBe(true);
    expect(isClient("vscode")).toBe(true);
  });
  it("rejects unknown values", () => {
    expect(isClient("antigravity")).toBe(false);
    expect(isClient("")).toBe(false);
    expect(isClient(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// parseSetupArgs
// ---------------------------------------------------------------------

describe("parseSetupArgs", () => {
  it("defaults wantConnector=true, wantDocs=true with no flags", () => {
    const r = parseSetupArgs(["setup", "claude-code"]);
    expect(r.client).toBe("claude-code");
    expect(r.wantConnector).toBe(true);
    expect(r.wantDocs).toBe(true);
    expect(r.help).toBe(false);
    expect(r.unknown).toEqual([]);
  });

  it("parses --no-connector", () => {
    const r = parseSetupArgs(["setup", "cursor", "--no-connector"]);
    expect(r.wantConnector).toBe(false);
    expect(r.wantDocs).toBe(true);
  });

  it("parses --no-docs", () => {
    const r = parseSetupArgs(["setup", "cursor", "--no-docs"]);
    expect(r.wantConnector).toBe(true);
    expect(r.wantDocs).toBe(false);
  });

  it("parses --help and -h", () => {
    expect(parseSetupArgs(["setup", "--help"]).help).toBe(true);
    expect(parseSetupArgs(["setup", "-h"]).help).toBe(true);
  });

  it("collects unrecognized flags into 'unknown'", () => {
    const r = parseSetupArgs(["setup", "cursor", "--lol"]);
    expect(r.unknown).toEqual(["--lol"]);
  });

  it("treats a second positional as unknown", () => {
    const r = parseSetupArgs(["setup", "cursor", "bonus-arg"]);
    expect(r.client).toBe("cursor");
    expect(r.unknown).toEqual(["bonus-arg"]);
  });

  it("flags can come before the client positional", () => {
    const r = parseSetupArgs(["setup", "--no-docs", "cursor"]);
    expect(r.client).toBe("cursor");
    expect(r.wantDocs).toBe(false);
  });
});

// ---------------------------------------------------------------------
// printSetupHelp
// ---------------------------------------------------------------------

describe("printSetupHelp", () => {
  it("lists every registered client", () => {
    const cap = captureDisplay();
    printSetupHelp(cap.io);
    const out = stripAnsi(cap.joined());
    for (const key of Object.keys(CLIENTS)) {
      expect(out).toContain(key);
    }
  });

  it("annotates each client with executes/prints to clarify behaviour", () => {
    const cap = captureDisplay();
    printSetupHelp(cap.io);
    const out = stripAnsi(cap.joined());
    expect(out).toMatch(/executes/);
    expect(out).toMatch(/prints instructions/);
  });

  it("documents both --no-connector and --no-docs", () => {
    const cap = captureDisplay();
    printSetupHelp(cap.io);
    const out = stripAnsi(cap.joined());
    expect(out).toContain("--no-connector");
    expect(out).toContain("--no-docs");
  });
});

// ---------------------------------------------------------------------
// runSetup — dispatch / argument errors
// ---------------------------------------------------------------------

describe("runSetup — dispatch", () => {
  it("prints help and returns 0 with no client + no flags", async () => {
    const cap = captureDisplay();
    const code = await runSetup(["setup"], { display: cap.io });
    expect(code).toBe(0);
    expect(stripAnsi(cap.joined())).toContain("setup <client>");
  });

  it("prints help on --help / -h", async () => {
    for (const flag of ["--help", "-h"]) {
      const cap = captureDisplay();
      const code = await runSetup(["setup", flag], { display: cap.io });
      expect(code).toBe(0);
      expect(stripAnsi(cap.joined())).toContain("setup <client>");
    }
  });

  it("returns 1 on unknown client", async () => {
    const cap = captureDisplay();
    const code = await runSetup(["setup", "antigravity"], { display: cap.io });
    expect(code).toBe(1);
    const out = stripAnsi(cap.joined());
    expect(out).toMatch(/Unknown client: antigravity/);
    expect(out).toContain("claude-code");
  });

  it("returns 1 on unknown flags", async () => {
    const cap = captureDisplay();
    const code = await runSetup(["setup", "cursor", "--lol"], { display: cap.io });
    expect(code).toBe(1);
    expect(stripAnsi(cap.joined())).toMatch(/Unrecognized argument/);
  });

  it("returns 1 when both --no-connector and --no-docs are passed (nothing to do)", async () => {
    const cap = captureDisplay();
    const code = await runSetup(
      ["setup", "claude-code", "--no-connector", "--no-docs"],
      { display: cap.io },
    );
    expect(code).toBe(1);
    expect(stripAnsi(cap.joined())).toMatch(/Nothing to do/);
  });
});

// ---------------------------------------------------------------------
// runSetup — claude-code, claude not on PATH (fallback path)
// ---------------------------------------------------------------------

describe("runSetup — claude-code, claude not on PATH", () => {
  it("returns 1, prints install link + both commands, never spawns (default both)", async () => {
    const cap = captureDisplay();
    const m = mockSpawn({ exitCode: 0, stdout: "", stderr: "" });
    const code = await runSetup(["setup", "claude-code"], {
      display: cap.io,
      which: () => null,
      spawnAsync: m.spawnAsync,
    });
    expect(code).toBe(1);
    expect(m.calls).toHaveLength(0);
    const out = stripAnsi(cap.joined());
    expect(out).toMatch(/claude CLI not found/i);
    expect(out).toContain("https://docs.anthropic.com/en/docs/claude-code");
    expect(out).toContain("claude mcp add --scope user jdcodec -- jdcodec");
    expect(out).toContain(
      "claude mcp add --transport http jdcodec-docs https://jdcodec.com/docs/mcp",
    );
  });

  it("only prints connector command when --no-docs", async () => {
    const cap = captureDisplay();
    await runSetup(["setup", "claude-code", "--no-docs"], {
      display: cap.io,
      which: () => null,
      spawnAsync: mockSpawn({ exitCode: 0, stdout: "", stderr: "" }).spawnAsync,
    });
    const out = stripAnsi(cap.joined());
    expect(out).toContain("claude mcp add --scope user jdcodec -- jdcodec");
    expect(out).not.toContain("jdcodec-docs");
  });

  it("only prints docs command when --no-connector", async () => {
    const cap = captureDisplay();
    await runSetup(["setup", "claude-code", "--no-connector"], {
      display: cap.io,
      which: () => null,
      spawnAsync: mockSpawn({ exitCode: 0, stdout: "", stderr: "" }).spawnAsync,
    });
    const out = stripAnsi(cap.joined());
    expect(out).toContain(
      "claude mcp add --transport http jdcodec-docs https://jdcodec.com/docs/mcp",
    );
    expect(out).not.toContain("--scope user jdcodec");
  });
});

// ---------------------------------------------------------------------
// runSetup — claude-code, claude on PATH
// ---------------------------------------------------------------------

describe("runSetup — claude-code, claude on PATH", () => {
  it("spawns connector and docs add commands by default; returns 0 on exit 0", async () => {
    const cap = captureDisplay();
    const m = mockSpawn({ exitCode: 0, stdout: "registered\n", stderr: "" });
    const code = await runSetup(["setup", "claude-code"], {
      display: cap.io,
      which: (cmd) => (cmd === "claude" ? "/usr/local/bin/claude" : null),
      spawnAsync: m.spawnAsync,
    });
    expect(code).toBe(0);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0].args).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "jdcodec",
      "--",
      "jdcodec",
    ]);
    expect(m.calls[1].args).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "jdcodec-docs",
      "https://jdcodec.com/docs/mcp",
    ]);
    const out = stripAnsi(cap.joined());
    expect(out).toMatch(/✓.*connector.*registered/i);
    expect(out).toMatch(/✓.*docs.*registered/i);
  });

  it("--no-docs spawns only the connector add", async () => {
    const m = mockSpawn({ exitCode: 0, stdout: "", stderr: "" });
    const code = await runSetup(["setup", "claude-code", "--no-docs"], {
      display: captureDisplay().io,
      which: () => "/usr/local/bin/claude",
      spawnAsync: m.spawnAsync,
    });
    expect(code).toBe(0);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].args).toContain("jdcodec");
  });

  it("--no-connector spawns only the docs add", async () => {
    const m = mockSpawn({ exitCode: 0, stdout: "", stderr: "" });
    const code = await runSetup(["setup", "claude-code", "--no-connector"], {
      display: captureDisplay().io,
      which: () => "/usr/local/bin/claude",
      spawnAsync: m.spawnAsync,
    });
    expect(code).toBe(0);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].args).toContain("jdcodec-docs");
  });

  it("returns 1 when one server fails but still attempts both", async () => {
    let callIndex = 0;
    const spawnAsync = async (
      cmd: string,
      args: string[],
    ): Promise<SpawnResult> => {
      callIndex++;
      if (callIndex === 1) {
        return { exitCode: 1, stdout: "", stderr: "Error: server 'jdcodec' already exists\n" };
      }
      return { exitCode: 0, stdout: "registered", stderr: "" };
    };
    const cap = captureDisplay();
    const code = await runSetup(["setup", "claude-code"], {
      display: cap.io,
      which: () => "/usr/local/bin/claude",
      spawnAsync,
    });
    expect(code).toBe(1);
    expect(callIndex).toBe(2); // both attempted
    const out = stripAnsi(cap.joined());
    expect(out).toContain("already exists");
    expect(out).toMatch(/already registered/i); // re-run guidance
  });
});

// ---------------------------------------------------------------------
// runSetup — manual clients (cursor / windsurf)
// ---------------------------------------------------------------------

describe("runSetup — manual clients", () => {
  for (const key of ["cursor", "windsurf"]) {
    const client = CLIENTS[key];
    if (client.kind !== "manual") continue;

    it(`${key}: prints config hint, server inputs, docs URL; returns 0; never spawns`, async () => {
      const cap = captureDisplay();
      const m = mockSpawn({ exitCode: 0, stdout: "", stderr: "" });
      const code = await runSetup(["setup", key], {
        display: cap.io,
        which: () => null, // shouldn't matter — manual clients never check `which`
        spawnAsync: m.spawnAsync,
      });
      expect(code).toBe(0);
      expect(m.calls).toHaveLength(0);
      const out = stripAnsi(cap.joined());
      expect(out).toContain(client.name);
      expect(out).toContain(client.configHint);
      expect(out).toContain(client.docsUrl);
      // Both server inputs by default
      expect(out).toContain("jdcodec");
      expect(out).toContain("jdcodec-docs");
      expect(out).toContain("https://jdcodec.com/docs/mcp");
    });
  }

  it("cursor --no-docs prints only the connector input", async () => {
    const cap = captureDisplay();
    await runSetup(["setup", "cursor", "--no-docs"], { display: cap.io });
    const out = stripAnsi(cap.joined());
    expect(out).toContain("jdcodec");
    expect(out).not.toContain("jdcodec-docs");
  });

  it("windsurf --no-connector prints only the docs input", async () => {
    const cap = captureDisplay();
    await runSetup(["setup", "windsurf", "--no-connector"], { display: cap.io });
    const out = stripAnsi(cap.joined());
    expect(out).toContain("jdcodec-docs");
    expect(out).toContain("https://jdcodec.com/docs/mcp");
    expect(out).not.toMatch(/command:\s*jdcodec/);
  });

  it("does not paste a JSON snippet (avoids drift with each client's schema)", async () => {
    const cap = captureDisplay();
    await runSetup(["setup", "cursor"], { display: cap.io });
    const out = stripAnsi(cap.joined());
    // Should describe the inputs in plain text, not include curly-brace JSON.
    expect(out).not.toMatch(/^{/m);
    expect(out).not.toMatch(/"mcpServers"/);
  });
});

// ---------------------------------------------------------------------
// runSetup — vscode (CLI client via `code --add-mcp`)
// ---------------------------------------------------------------------

describe("runSetup — vscode, code not on PATH", () => {
  it("returns 1, prints install instructions + both add-mcp commands, never spawns", async () => {
    const cap = captureDisplay();
    const m = mockSpawn({ exitCode: 0, stdout: "", stderr: "" });
    const code = await runSetup(["setup", "vscode"], {
      display: cap.io,
      which: () => null,
      spawnAsync: m.spawnAsync,
    });
    expect(code).toBe(1);
    expect(m.calls).toHaveLength(0);
    const out = stripAnsi(cap.joined());
    expect(out).toMatch(/code CLI not found/i);
    expect(out).toContain("Shell Command: Install 'code'");
    // Both add-mcp commands shown so the customer can copy-paste once
    // they install the `code` shell command.
    expect(out).toContain(`code --add-mcp '{"name":"jdcodec","command":"jdcodec"}'`);
    expect(out).toContain(
      `code --add-mcp '{"name":"jdcodec-docs","type":"http","url":"https://jdcodec.com/docs/mcp"}'`,
    );
  });
});

describe("runSetup — vscode, code on PATH", () => {
  it("spawns `code --add-mcp` for both servers by default; returns 0 on exit 0", async () => {
    const cap = captureDisplay();
    const m = mockSpawn({ exitCode: 0, stdout: "Added MCP server.\n", stderr: "" });
    const code = await runSetup(["setup", "vscode"], {
      display: cap.io,
      which: (cmd) => (cmd === "code" ? "/usr/local/bin/code" : null),
      spawnAsync: m.spawnAsync,
    });
    expect(code).toBe(0);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0].cmd).toBe("code");
    expect(m.calls[0].args[0]).toBe("--add-mcp");
    expect(JSON.parse(m.calls[0].args[1])).toEqual({
      name: "jdcodec",
      command: "jdcodec",
    });
    expect(m.calls[1].cmd).toBe("code");
    expect(JSON.parse(m.calls[1].args[1])).toEqual({
      name: "jdcodec-docs",
      type: "http",
      url: "https://jdcodec.com/docs/mcp",
    });
    const out = stripAnsi(cap.joined());
    expect(out).toMatch(/✓.*connector.*registered/i);
    expect(out).toMatch(/✓.*docs.*registered/i);
  });

  it("--no-docs spawns only the connector add-mcp", async () => {
    const m = mockSpawn({ exitCode: 0, stdout: "", stderr: "" });
    const code = await runSetup(["setup", "vscode", "--no-docs"], {
      display: captureDisplay().io,
      which: () => "/usr/local/bin/code",
      spawnAsync: m.spawnAsync,
    });
    expect(code).toBe(0);
    expect(m.calls).toHaveLength(1);
    const config = JSON.parse(m.calls[0].args[1]);
    expect(config.name).toBe("jdcodec");
    expect(config.command).toBe("jdcodec");
    expect(config.type).toBeUndefined();
  });

  it("--no-connector spawns only the docs add-mcp (HTTP shape)", async () => {
    const m = mockSpawn({ exitCode: 0, stdout: "", stderr: "" });
    const code = await runSetup(["setup", "vscode", "--no-connector"], {
      display: captureDisplay().io,
      which: () => "/usr/local/bin/code",
      spawnAsync: m.spawnAsync,
    });
    expect(code).toBe(0);
    expect(m.calls).toHaveLength(1);
    const config = JSON.parse(m.calls[0].args[1]);
    expect(config.name).toBe("jdcodec-docs");
    expect(config.type).toBe("http");
    expect(config.url).toBe("https://jdcodec.com/docs/mcp");
  });

  it("returns 1 when one server fails but still attempts both", async () => {
    let callIndex = 0;
    const spawnAsync = async (): Promise<SpawnResult> => {
      callIndex++;
      if (callIndex === 1) {
        return { exitCode: 1, stdout: "", stderr: "Error: server already exists\n" };
      }
      return { exitCode: 0, stdout: "Added", stderr: "" };
    };
    const cap = captureDisplay();
    const code = await runSetup(["setup", "vscode"], {
      display: cap.io,
      which: () => "/usr/local/bin/code",
      spawnAsync,
    });
    expect(code).toBe(1);
    expect(callIndex).toBe(2);
    expect(stripAnsi(cap.joined())).toMatch(/already registered/i);
  });
});
