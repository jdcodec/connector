/**
 * `jdcodec setup <client> [--no-connector] [--no-docs]` — one-shot
 * MCP wiring helper.
 *
 * Two MCP servers are exposed by JD Codec:
 *
 *   - **connector** (`jdcodec`) — the local stdio MCP server in this
 *     package. Wired so the customer's AI agent can take browser
 *     snapshots through JD Codec.
 *   - **docs** (`jdcodec-docs`) — an HTTP MCP server at
 *     `https://jdcodec.com/docs/mcp`. Wired so the customer's AI
 *     agent can answer questions about JD Codec from the live docs
 *     instead of training data.
 *
 * Four clients are supported today, in two flavours:
 *
 *   CLI clients (auto-execute, fall back to printed commands):
 *   - `claude-code` — `claude mcp add ...`
 *   - `vscode`      — `code --add-mcp '{json}'`
 *
 *   Manual clients (print config path + stable inputs + docs link):
 *   - `cursor`      — `agent` CLI exists but only manages already-
 *                     registered servers; no `agent mcp add`, so
 *                     registration requires editing `~/.cursor/mcp.json`.
 *   - `windsurf`    — no CLI add. GUI + JSON editing. The
 *                     `windsurf://windsurf-mcp-registry?serverName=...`
 *                     deeplink only works for servers already in
 *                     Windsurf's MCP marketplace; JDC isn't listed
 *                     there yet.
 *
 * The split between CLI and manual is per-client capability, not a
 * stylistic choice. Each CLI client provides a `buildArgs(server)`
 * function that turns a ServerSpec into the right add-args for that
 * client — Claude Code uses positional args, VS Code packs the
 * config into a `--add-mcp '{json}'` flag.
 *
 * Default behaviour: `jdcodec setup <client>` wires **both** servers.
 * Pass `--no-connector` or `--no-docs` to opt out of one. Passing
 * both is rejected (no-op).
 *
 * Why no idempotency pre-check on the CLI paths: parsing each
 * client's "list" output couples this code to a format we don't
 * control. Re-running setup is safe; the "already exists" failure
 * mode is benign and we say so.
 */

import { spawn, spawnSync } from "node:child_process";

import { defaultDisplay, DisplayIO, DOCS_URL, palette } from "./display.js";

// ---------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------

export type ServerKey = "connector" | "docs";
export type Transport = "stdio" | "http";

export interface ServerSpec {
  key: ServerKey;
  /** MCP server name as registered in client configs. */
  name: string;
  /** Human-readable label for status messages. */
  label: string;
  /** Transport flavour — drives how each CLI client formats its add-args. */
  transport: Transport;
  /** stdio command, e.g. `"jdcodec"`. Set when transport === "stdio". */
  command?: string;
  /** HTTP URL. Set when transport === "http". */
  url?: string;
  /** Plain-text description for manual-add clients. */
  manualDescription: string;
}

export const SERVERS: Record<ServerKey, ServerSpec> = {
  connector: {
    key: "connector",
    name: "jdcodec",
    label: "JD Codec connector",
    transport: "stdio",
    command: "jdcodec",
    manualDescription: "command: jdcodec   (stdio MCP server)",
  },
  docs: {
    key: "docs",
    name: "jdcodec-docs",
    label: "JD Codec docs MCP",
    transport: "http",
    url: `${DOCS_URL}/mcp`,
    manualDescription: `url: ${DOCS_URL}/mcp   (HTTP MCP server)`,
  },
};

// ---------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------

interface CliClient {
  kind: "cli";
  /** Display name for the client. */
  name: string;
  /** Executable to detect on PATH. */
  cmd: string;
  /** URL to the client's install / shell-command-setup instructions. */
  installUrl: string;
  /**
   * Build the `cmd`-specific add-args for a single server. Each CLI
   * client formats its add-args differently — Claude Code uses
   * positional args, VS Code packs the config into a `--add-mcp`
   * JSON flag.
   */
  buildArgs: (server: ServerSpec) => string[];
}

interface ManualClient {
  kind: "manual";
  /** Display name for the client. */
  name: string;
  /** Where the customer should add the MCP server config. */
  configHint: string;
  /** URL to the client's official MCP setup docs. */
  docsUrl: string;
}

export type ClientSpec = CliClient | ManualClient;

/**
 * Builds the `claude mcp add ...` args for one server. stdio and
 * http use different positional patterns; this is the canonical
 * mapping per Claude Code's CLI docs.
 */
function buildClaudeArgs(server: ServerSpec): string[] {
  if (server.transport === "stdio") {
    return ["mcp", "add", "--scope", "user", server.name, "--", server.command!];
  }
  return ["mcp", "add", "--transport", "http", server.name, server.url!];
}

/**
 * Builds the `code --add-mcp '{json}'` args for one server. VS Code
 * accepts the same JSON shape its `mcp.json` config uses, so stdio
 * and http both serialize through the same flag — only the inner
 * JSON shape differs.
 */
function buildVscodeArgs(server: ServerSpec): string[] {
  const config =
    server.transport === "stdio"
      ? { name: server.name, command: server.command! }
      : { name: server.name, type: "http", url: server.url! };
  return ["--add-mcp", JSON.stringify(config)];
}

export const CLIENTS: Record<string, ClientSpec> = {
  "claude-code": {
    kind: "cli",
    name: "Claude Code",
    cmd: "claude",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code",
    buildArgs: buildClaudeArgs,
  },
  cursor: {
    kind: "manual",
    name: "Cursor",
    configHint: "~/.cursor/mcp.json (create the file if it doesn't exist)",
    docsUrl: "https://docs.cursor.com/context/model-context-protocol",
  },
  windsurf: {
    kind: "manual",
    name: "Windsurf",
    configHint:
      "~/.codeium/windsurf/mcp_config.json (create the file if it doesn't exist), or use Settings > Tools > Windsurf Settings > Add Server in the GUI",
    docsUrl: "https://docs.windsurf.com/windsurf/cascade/mcp",
  },
  vscode: {
    kind: "cli",
    name: "VS Code",
    cmd: "code",
    installUrl:
      "https://code.visualstudio.com/docs/setup/setup-overview (if installed but `code` isn't on PATH, run \"Shell Command: Install 'code' command in PATH\" from the Command Palette in VS Code)",
    buildArgs: buildVscodeArgs,
  },
};

const CLIENT_KEYS = Object.keys(CLIENTS);

export function isClient(arg: string | undefined): arg is keyof typeof CLIENTS {
  return arg !== undefined && Object.prototype.hasOwnProperty.call(CLIENTS, arg);
}

// ---------------------------------------------------------------------
// IO + spawn
// ---------------------------------------------------------------------

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SetupIO {
  /** Defaults to a real `which` lookup via spawnSync. */
  which?: (cmd: string) => string | null;
  /** Defaults to spawning a real subprocess. */
  spawnAsync?: (cmd: string, args: string[]) => Promise<SpawnResult>;
  /** Defaults to defaultDisplay. */
  display?: DisplayIO;
}

function defaultWhich(cmd: string): string | null {
  try {
    const result = spawnSync("which", [cmd], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim() || null;
    return null;
  } catch {
    return null;
  }
}

function defaultSpawnAsync(cmd: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      resolve({ exitCode: null, stdout, stderr: stderr || err.message });
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------

export interface ParsedSetupArgs {
  /** True if --help / -h was passed. */
  help: boolean;
  /** Client key (validated against CLIENTS), or null if missing. */
  client: string | null;
  /** True unless --no-connector was passed. */
  wantConnector: boolean;
  /** True unless --no-docs was passed. */
  wantDocs: boolean;
  /** Unrecognized positional or flag, surfaced for error reporting. */
  unknown: string[];
}

const HELP_FLAGS = new Set(["--help", "-h"]);
const NO_CONNECTOR_FLAGS = new Set(["--no-connector", "--connector=false"]);
const NO_DOCS_FLAGS = new Set(["--no-docs", "--docs=false"]);

export function parseSetupArgs(args: string[]): ParsedSetupArgs {
  // args[0] is "setup"; everything from args[1] onwards is what
  // belongs to this subcommand.
  const tail = args.slice(1);
  const result: ParsedSetupArgs = {
    help: false,
    client: null,
    wantConnector: true,
    wantDocs: true,
    unknown: [],
  };
  for (const tok of tail) {
    if (HELP_FLAGS.has(tok)) {
      result.help = true;
      continue;
    }
    if (NO_CONNECTOR_FLAGS.has(tok)) {
      result.wantConnector = false;
      continue;
    }
    if (NO_DOCS_FLAGS.has(tok)) {
      result.wantDocs = false;
      continue;
    }
    if (tok.startsWith("-")) {
      result.unknown.push(tok);
      continue;
    }
    if (result.client === null) {
      result.client = tok;
    } else {
      result.unknown.push(tok);
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// Help + error printing
// ---------------------------------------------------------------------

export function printSetupHelp(display: DisplayIO = defaultDisplay): void {
  display.print(palette.bold("jdcodec setup <client> [--no-connector] [--no-docs]"));
  display.print("");
  display.print(" Wires JD Codec's MCP servers into your AI client.");
  display.print(" By default both the connector AND the docs server are wired.");
  display.print("");
  display.print(" Clients:");
  for (const key of CLIENT_KEYS) {
    const c = CLIENTS[key];
    const note = c.kind === "cli" ? "(executes)" : "(prints instructions)";
    display.print(`  ${palette.info(key.padEnd(12))}${c.name} ${palette.dim(note)}`);
  }
  display.print("");
  display.print(" Servers (both wired by default):");
  display.print(`  ${palette.dim("connector")}  ${SERVERS.connector.label} (stdio)`);
  display.print(`  ${palette.dim("docs")}       ${SERVERS.docs.label} (HTTP)`);
  display.print("");
  display.print(" Examples:");
  display.print(`  ${palette.bold("jdcodec setup claude-code")}              wire both into Claude Code`);
  display.print(`  ${palette.bold("jdcodec setup vscode")}                   wire both into VS Code`);
  display.print(`  ${palette.bold("jdcodec setup cursor")}                   show Cursor wiring instructions`);
  display.print(`  ${palette.bold("jdcodec setup claude-code --no-connector")} docs only into Claude Code`);
  display.print("");
}

function printUnknownClient(arg: string, display: DisplayIO): void {
  display.print(palette.danger(`Unknown client: ${arg}`));
  display.print("");
  display.print("Available clients:");
  for (const key of CLIENT_KEYS) {
    display.print(`  ${palette.info(key)}`);
  }
  display.print("");
  display.print(`Run \`${palette.bold("jdcodec setup")}\` (no args) for full help.`);
}

function printNothingToDo(display: DisplayIO): void {
  display.print(palette.danger("Nothing to do — both --no-connector and --no-docs were passed."));
  display.print(`Run \`${palette.bold("jdcodec setup")}\` (no args) for full help.`);
}

function printUnknownFlags(unknown: string[], display: DisplayIO): void {
  display.print(palette.danger(`Unrecognized argument(s): ${unknown.join(" ")}`));
  display.print(`Run \`${palette.bold("jdcodec setup")}\` (no args) for full help.`);
}

// ---------------------------------------------------------------------
// Client kind = "cli" — execute or fallback to printed command
// ---------------------------------------------------------------------

function quoteArg(s: string): string {
  return /[\s"'`$\\&|;<>()]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

function commandLine(cmd: string, args: string[]): string {
  return [cmd, ...args.map(quoteArg)].join(" ");
}

async function executeCliClient(
  client: CliClient,
  servers: ServerSpec[],
  io: Required<Pick<SetupIO, "which" | "spawnAsync" | "display">>,
): Promise<number> {
  const { which, spawnAsync, display } = io;
  const found = which(client.cmd);

  if (!found) {
    display.print(palette.warning(`${client.cmd} CLI not found on PATH.`));
    display.print("");
    display.print(`Install ${client.name}: ${palette.cyanUnderline(client.installUrl)}`);
    display.print("");
    display.print("Then run:");
    for (const server of servers) {
      display.print(`  ${palette.bold(commandLine(client.cmd, client.buildArgs(server)))}`);
    }
    return 1;
  }

  let worstExit = 0;
  for (const server of servers) {
    const args = client.buildArgs(server);
    display.print(`Wiring ${server.label} into ${client.name}...`);
    display.print(palette.dim(`$ ${commandLine(client.cmd, args)}`));
    const result = await spawnAsync(client.cmd, args);
    if (result.stdout.trim()) display.print(result.stdout.trimEnd());
    if (result.stderr.trim()) display.print(palette.dim(result.stderr.trimEnd()));
    if (result.exitCode === 0) {
      display.print(palette.success(`✓ ${server.label} registered.`));
    } else {
      display.print(
        palette.danger(`✗ ${client.cmd} exited ${result.exitCode ?? "unknown"}.`),
      );
      display.print(
        palette.dim(
          "If this server is already registered, this is harmless — re-running setup is safe.",
        ),
      );
      worstExit = 1;
    }
    display.print("");
  }
  return worstExit;
}

// ---------------------------------------------------------------------
// Client kind = "manual" — print config hints + server inputs + docs link
// ---------------------------------------------------------------------

function executeManualClient(
  client: ManualClient,
  servers: ServerSpec[],
  display: DisplayIO,
): number {
  display.print(palette.bold(`${client.name} setup`));
  display.print("");
  display.print(`Open ${client.configHint}.`);
  display.print("");
  display.print(
    "JD Codec exposes the following MCP server(s); add them to the file using your client's MCP config schema:",
  );
  display.print("");
  for (const server of servers) {
    display.print(`  ${palette.info(server.name)}`);
    display.print(`    ${server.manualDescription}`);
    display.print("");
  }
  display.print(
    `${client.name} MCP setup guide: ${palette.cyanUnderline(client.docsUrl)}`,
  );
  display.print("");
  display.print(
    palette.dim(
      "We don't paste a JSON snippet because each client's exact schema mutates over time. " +
        "The inputs above (command name for stdio, URL for HTTP) are stable; consult the link above for the wrapper shape.",
    ),
  );
  // Print-only path — no side effect, so exit 0 even though we
  // didn't actually register anything ourselves. The customer
  // still has work to do, but `setup` itself succeeded.
  return 0;
}

// ---------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------

export async function runSetup(
  args: string[],
  opts: SetupIO = {},
): Promise<number> {
  const display = opts.display ?? defaultDisplay;
  const parsed = parseSetupArgs(args);

  if (parsed.help || (parsed.client === null && parsed.unknown.length === 0)) {
    printSetupHelp(display);
    return 0;
  }
  if (parsed.unknown.length > 0) {
    printUnknownFlags(parsed.unknown, display);
    return 1;
  }
  if (parsed.client === null) {
    printSetupHelp(display);
    return 0;
  }
  if (!isClient(parsed.client)) {
    printUnknownClient(parsed.client, display);
    return 1;
  }
  if (!parsed.wantConnector && !parsed.wantDocs) {
    printNothingToDo(display);
    return 1;
  }

  const servers: ServerSpec[] = [];
  if (parsed.wantConnector) servers.push(SERVERS.connector);
  if (parsed.wantDocs) servers.push(SERVERS.docs);

  const client = CLIENTS[parsed.client];
  if (client.kind === "cli") {
    return executeCliClient(client, servers, {
      which: opts.which ?? defaultWhich,
      spawnAsync: opts.spawnAsync ?? defaultSpawnAsync,
      display,
    });
  }
  return executeManualClient(client, servers, display);
}
