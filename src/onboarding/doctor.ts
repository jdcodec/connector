/**
 * `jdcodec doctor` — first-run diagnostic for the local connector.
 *
 * Answers one question for a customer: "is JD Codec installed,
 * authenticated, and able to reach the cloud?" Each probe runs
 * independently and contributes a single line to the report; failures
 * never abort the run, so the customer sees the full picture in one
 * pass instead of having to re-run after each fix.
 *
 * Probes are pure-ish: each takes the IO and config it needs as
 * parameters, which makes them easy to unit-test with synthetic
 * inputs. The orchestrator at the bottom wires defaults for
 * production use.
 *
 * Exit code rules:
 *   0  — all probes ok (warnings allowed)
 *   1  — at least one probe failed
 *   2  — reserved for catastrophic doctor failure (uncaught throw)
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultDisplay, DisplayIO, DOCS_URL, palette } from "./display.js";
import { VERSION } from "./version.js";

const MIN_NODE_MAJOR = 22;
const PLAYWRIGHT_PROBE_TIMEOUT_MS = 10_000;
const CLOUD_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_CLOUD_URL = "https://api.jdcodec.com";

/**
 * Subset of docs pages the doctor links to. Quickstart is the only
 * customer-facing setup page that exists at the time of writing —
 * once specific guides ship (api keys, common errors), update these
 * targets in this single map. Keeping them all in one place means a
 * docs URL refactor is a one-diff change, not a sweep.
 */
const DOCS = {
  setup: `${DOCS_URL}/quickstart`,
  apiKeys: `${DOCS_URL}/quickstart`,
  errors: DOCS_URL,
} as const;

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** One-line summary printed next to the status badge. */
  detail: string;
  /** Optional multi-line fix instructions printed indented under the line. */
  hint?: string;
  /** Optional docs URL appended after the hint. */
  docsLink?: string;
}

export interface SpawnResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  /** True if the process timed out before exiting. */
  timedOut?: boolean;
}

export interface DoctorIO {
  /** Defaults to `process.versions`. */
  processVersions?: { node: string };
  /** Defaults to `process.env.PATH`. */
  pathEnv?: string;
  /** Defaults to `which <cmd>` lookup via spawnSync. */
  which?: (cmd: string) => string | null;
  /** Defaults to `which -a <cmd>` lookup via spawnSync. Returns every
   *  matching path on PATH (deduped, in PATH order). */
  whichAll?: (cmd: string) => string[];
  /** Defaults to spawning a real subprocess. */
  spawnAsync?: (cmd: string, args: string[], timeoutMs: number) => Promise<SpawnResult>;
  /** Defaults to fs.existsSync + readFileSync. */
  readFile?: (path: string) => string | null;
  /** Defaults to `~/.jdcodec/config.json`. */
  configPath?: string;
  /** Defaults to `process.env.JDC_API_KEY`. */
  apiKeyEnv?: string | undefined;
  /** Defaults to `https://api.jdcodec.com` (or JDC_CLOUD_URL). */
  cloudUrl?: string;
  /** Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to crypto.randomUUID. */
  generateRequestId?: () => string;
  /** Defaults to defaultDisplay (writes to stdout). */
  display?: DisplayIO;
}

// ---------------------------------------------------------------------
// Probe 1 — Node version
// ---------------------------------------------------------------------

export function probeNodeVersion(version: string): CheckResult {
  const major = parseInt(version.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    return {
      name: "Node version",
      status: "fail",
      detail: `v${version} (need ${MIN_NODE_MAJOR}+)`,
      hint: `Install Node ${MIN_NODE_MAJOR} or newer. nvm: 'nvm install ${MIN_NODE_MAJOR}'. Official installer: https://nodejs.org/.`,
      docsLink: DOCS.setup,
    };
  }
  return {
    name: "Node version",
    status: "ok",
    detail: `v${version}`,
  };
}

// ---------------------------------------------------------------------
// Probe 2 — npx on PATH
// ---------------------------------------------------------------------

export function probeNpx(whichResult: string | null): CheckResult {
  if (!whichResult) {
    return {
      name: "npx on PATH",
      status: "fail",
      detail: "not found",
      hint: "npx ships with npm. If Node is installed but npx is missing, your PATH may not include npm's bin directory.",
      docsLink: DOCS.setup,
    };
  }
  return {
    name: "npx on PATH",
    status: "ok",
    detail: whichResult,
  };
}

// ---------------------------------------------------------------------
// Probe 3 — Playwright MCP spawnability
// ---------------------------------------------------------------------

export async function probePlaywrightMcp(
  spawnAsync: (cmd: string, args: string[], timeoutMs: number) => Promise<SpawnResult>,
): Promise<CheckResult> {
  try {
    const result = await spawnAsync(
      "npx",
      ["@playwright/mcp", "--help"],
      PLAYWRIGHT_PROBE_TIMEOUT_MS,
    );
    if (result.timedOut) {
      return {
        name: "Playwright MCP",
        status: "warn",
        detail: "spawn timed out",
        hint: "Slow first install can take longer than the probe budget. Try `npx @playwright/mcp --help` directly to confirm — the proxy will install on first use.",
      };
    }
    if (result.exitCode === 0) {
      return {
        name: "Playwright MCP",
        status: "ok",
        detail: "available",
      };
    }
    return {
      name: "Playwright MCP",
      status: "warn",
      detail: `npx exited ${result.exitCode ?? "?"}`,
      hint: "Playwright MCP is lazy-installed by npx on first use. The proxy may still work even if this probe fails — try running `jdcodec` once.",
    };
  } catch (err) {
    return {
      name: "Playwright MCP",
      status: "warn",
      detail: `probe error: ${(err as Error)?.message ?? "unknown"}`,
      hint: "Spawn failed before the subprocess could start. Confirm npx works: `npx --version`.",
    };
  }
}

// ---------------------------------------------------------------------
// Probe 4 — connector version (always ok; informational)
// ---------------------------------------------------------------------

export function probeConnectorVersion(): CheckResult {
  return {
    name: "Connector version",
    status: "ok",
    detail: `jdcodec ${VERSION}`,
  };
}

// ---------------------------------------------------------------------
// Probe 5 — config file shape (without printing secrets)
// ---------------------------------------------------------------------

export interface ConfigProbeOutput {
  result: CheckResult;
  /** Resolved api key (env wins over file), or null. Returned so the
   *  key-shape probe doesn't have to re-do this work. */
  apiKey: string | null;
  /** Where the api key was found, for downstream messaging. */
  source: "env" | "file" | null;
}

export function probeConfigFile(
  configPath: string,
  apiKeyEnv: string | undefined,
  readFile: (path: string) => string | null,
): ConfigProbeOutput {
  if (apiKeyEnv && apiKeyEnv.trim() !== "") {
    return {
      result: {
        name: "Config",
        status: "ok",
        detail: "JDC_API_KEY env var set",
      },
      apiKey: apiKeyEnv.trim(),
      source: "env",
    };
  }
  const raw = readFile(configPath);
  if (raw === null) {
    return {
      result: {
        name: "Config",
        status: "fail",
        detail: `no JDC_API_KEY env and no ${configPath}`,
        hint: "Run `jdcodec start` to register and write a key, or set JDC_API_KEY in your shell.",
        docsLink: DOCS.setup,
      },
      apiKey: null,
      source: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      result: {
        name: "Config",
        status: "fail",
        detail: `${configPath} exists but is not valid JSON`,
        hint: `Open ${configPath} and confirm it parses as JSON. The expected shape is {"api_key": "jdck_...id....secret"}.`,
        docsLink: DOCS.apiKeys,
      },
      apiKey: null,
      source: null,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      result: {
        name: "Config",
        status: "fail",
        detail: `${configPath} is not a JSON object`,
        hint: `Expected {"api_key": "..."}; found a different JSON shape.`,
        docsLink: DOCS.apiKeys,
      },
      apiKey: null,
      source: null,
    };
  }
  const apiKey = (parsed as { api_key?: unknown }).api_key;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return {
      result: {
        name: "Config",
        status: "fail",
        detail: `${configPath} has no api_key field`,
        hint: `Add {"api_key": "jdck_...id....secret"} to ${configPath}. Get a key with \`jdcodec start\`.`,
        docsLink: DOCS.apiKeys,
      },
      apiKey: null,
      source: null,
    };
  }
  return {
    result: {
      name: "Config",
      status: "ok",
      detail: `${configPath} (api_key present, length ${apiKey.length})`,
    },
    apiKey: apiKey.trim(),
    source: "file",
  };
}

// ---------------------------------------------------------------------
// Probe 6 — API key shape
// ---------------------------------------------------------------------

const KEY_PREFIX = "jdck_";
const KEY_ID_HEX_RE = /^jdck_[0-9a-f]{16}$/;

export function probeKeyShape(apiKey: string | null): CheckResult {
  if (apiKey === null) {
    return {
      name: "API key shape",
      status: "fail",
      detail: "no key resolved (see Config probe above)",
      docsLink: DOCS.apiKeys,
    };
  }
  if (!apiKey.startsWith(KEY_PREFIX)) {
    return {
      name: "API key shape",
      status: "fail",
      detail: `key does not start with '${KEY_PREFIX}'`,
      hint: `Bearer keys begin with '${KEY_PREFIX}'. If you pasted something else (e.g. a webhook URL), re-run \`jdcodec start\` to fetch a fresh key.`,
      docsLink: DOCS.apiKeys,
    };
  }
  const dotIdx = apiKey.indexOf(".");
  if (dotIdx === -1) {
    return {
      name: "API key shape",
      status: "fail",
      detail: "key has only the public id (missing '.<secret>' half)",
      hint: `A complete bearer is two halves separated by a dot: \`${KEY_PREFIX}<id>.<secret>\`. The id half alone (~22 chars) cannot authenticate. Look in the email or terminal output where the key was issued — the secret half follows the dot.`,
      docsLink: DOCS.apiKeys,
    };
  }
  const idPart = apiKey.slice(0, dotIdx);
  const secretPart = apiKey.slice(dotIdx + 1);
  if (!KEY_ID_HEX_RE.test(idPart)) {
    return {
      name: "API key shape",
      status: "fail",
      detail: `id half '${idPart}' is not 'jdck_' + 16 hex chars`,
      hint: "Re-copy the bearer carefully. Whitespace inside the id half is the most common cause.",
      docsLink: DOCS.apiKeys,
    };
  }
  if (secretPart.length < 16) {
    return {
      name: "API key shape",
      status: "fail",
      detail: `secret half is only ${secretPart.length} chars (expected longer)`,
      hint: "The secret half got truncated during paste. Re-copy the full key from where it was issued.",
      docsLink: DOCS.apiKeys,
    };
  }
  return {
    name: "API key shape",
    status: "ok",
    detail: `${idPart}.<secret-${secretPart.length}-chars>`,
  };
}

// ---------------------------------------------------------------------
// Probe 7 — cloud auth probe
// ---------------------------------------------------------------------

export interface CloudProbeInput {
  cloudUrl: string;
  apiKey: string | null;
  fetchImpl: typeof fetch;
  generateRequestId: () => string;
  timeoutMs?: number;
}

/**
 * Sends a deliberately malformed `POST /v1/snapshot` with the bearer
 * attached. Auth runs before body validation in the worker, so:
 *   - 400 malformed_request → AUTH OK (the only failure was our body)
 *   - 401 auth_invalid / auth_revoked → AUTH FAIL (specific reason)
 *   - 5xx → upstream issue, can't tell — report as warn
 *   - network error / timeout → report as warn
 *
 * Cheap by design: no session is created, no usage event emitted,
 * because the request never reaches the snapshot handler past auth.
 */
export async function probeCloudAuth(input: CloudProbeInput): Promise<CheckResult> {
  const { cloudUrl, apiKey, fetchImpl, generateRequestId } = input;
  const timeoutMs = input.timeoutMs ?? CLOUD_PROBE_TIMEOUT_MS;
  if (apiKey === null) {
    return {
      name: "Cloud auth",
      status: "fail",
      detail: "skipped — no API key resolved",
      docsLink: DOCS.apiKeys,
    };
  }
  const url = `${cloudUrl.replace(/\/+$/, "")}/v1/snapshot`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-JDC-API-Version": "1",
        "X-Request-Id": generateRequestId(),
        Authorization: `Bearer ${apiKey}`,
      },
      body: "{}",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    const name = (err as Error)?.name;
    if (name === "AbortError") {
      return {
        name: "Cloud auth",
        status: "warn",
        detail: `timeout after ${timeoutMs} ms reaching ${cloudUrl}`,
        hint: "Network unreachable or the cloud is slow to respond. Confirm `curl https://api.jdcodec.com/v1/health` works from this machine.",
        docsLink: DOCS.errors,
      };
    }
    return {
      name: "Cloud auth",
      status: "warn",
      detail: `network error: ${(err as Error)?.message ?? "unknown"}`,
      hint: "Probe could not reach the cloud. Check connectivity, DNS, and any corporate proxy.",
      docsLink: DOCS.errors,
    };
  }
  clearTimeout(timeoutHandle);

  let body: { error?: { code?: string; message?: string } } = {};
  try {
    body = (await res.json()) as { error?: { code?: string; message?: string } };
  } catch {
    // Non-JSON response (e.g. an HTML error page from a proxy).
  }
  const code = body.error?.code ?? "";

  if (res.status === 401) {
    if (code === "auth_revoked") {
      return {
        name: "Cloud auth",
        status: "fail",
        detail: "401 auth_revoked",
        hint: "This key was revoked. Request a new one — `jdcodec start` will issue one.",
        docsLink: DOCS.apiKeys,
      };
    }
    return {
      name: "Cloud auth",
      status: "fail",
      detail: `401 ${code || "auth_invalid"}`,
      hint: "Cloud rejected the bearer. Re-check the full `jdck_<id>.<secret>` value, or re-run `jdcodec start` to fetch a fresh key.",
      docsLink: DOCS.apiKeys,
    };
  }
  if (res.status === 400 && code === "malformed_request") {
    return {
      name: "Cloud auth",
      status: "ok",
      detail: "bearer accepted by cloud",
    };
  }
  if (res.status >= 500) {
    return {
      name: "Cloud auth",
      status: "warn",
      detail: `${res.status} ${code || "server_error"} — cannot determine auth state`,
      hint: "Cloud is returning a server error. Try again in a minute. If it persists, check status updates.",
      docsLink: DOCS.errors,
    };
  }
  // Anything else (e.g. 413, 429) means auth passed but a different
  // gate tripped — that's still useful "bearer is accepted" signal.
  return {
    name: "Cloud auth",
    status: "ok",
    detail: `bearer accepted (cloud returned ${res.status} ${code || "—"})`,
  };
}

// ---------------------------------------------------------------------
// Probe 8 — npm-global PATH detection
// ---------------------------------------------------------------------

const NPM_BIN_HINTS = [
  "/.npm-global/bin",
  "/.local/bin",
  "/.nvm/",
  "/.fnm/",
  "/.volta/",
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

export function probeNpmGlobalPath(pathEnv: string): CheckResult {
  const segments = pathEnv.split(":").filter(Boolean);
  const hit = segments.find((seg) =>
    NPM_BIN_HINTS.some((hint) => seg.includes(hint)),
  );
  if (!hit) {
    return {
      name: "npm-global PATH",
      status: "warn",
      detail: "no obvious npm-bin directory on PATH",
      hint: "If `jdcodec` is installed globally but not found on PATH, configure a non-sudo prefix: `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to your PATH.",
      docsLink: DOCS.setup,
    };
  }
  return {
    name: "npm-global PATH",
    status: "ok",
    detail: `found ${hit}`,
  };
}

// ---------------------------------------------------------------------
// Probe 9 — multiple `jdcodec` binaries on PATH
// ---------------------------------------------------------------------

/**
 * Detects the failure mode where multiple `jdcodec` binaries shadow
 * each other on PATH (e.g. a pip-installed wrapper at
 * `~/.local/bin/jdcodec` AND a leftover `npm install -g jdcodec`
 * at `~/.npm-global/bin/jdcodec`). The first match wins, but the
 * second can still be reached by other tools (notably `npx`) — which
 * is exactly how a stale global install can keep serving an old
 * version even when the user thinks they've upgraded.
 *
 * Warns on multi-match. PATH-deduped — if the user's PATH lists the
 * same directory twice (common shell-rc footgun) the same path
 * appearing twice is collapsed to one.
 */
export function probeMultipleBinaries(paths: string[]): CheckResult {
  const unique = Array.from(new Set(paths.map((p) => p.trim()).filter(Boolean)));
  if (unique.length === 0) {
    return {
      name: "jdcodec on PATH",
      status: "warn",
      detail: "no jdcodec binary found on PATH",
      hint: "If you ran this via `jdcodec doctor`, this probe is internally inconsistent — please report it.",
    };
  }
  if (unique.length === 1) {
    return {
      name: "jdcodec on PATH",
      status: "ok",
      detail: `single binary at ${unique[0]}`,
    };
  }
  const list = unique.map((p) => `  ${p}`).join("\n");
  return {
    name: "jdcodec on PATH",
    status: "warn",
    detail: `${unique.length} binaries shadow each other`,
    hint:
      `Multiple jdcodec binaries are visible on PATH. The first match wins:\n${list}\n` +
      `Pick one canonical install path. The most common cause is a leftover ` +
      `\`npm install -g jdcodec\` from before you switched to a managed installer ` +
      `(e.g. pipx). Remove the stale one with \`npm uninstall -g jdcodec\` if applicable.`,
    docsLink: DOCS.setup,
  };
}

// ---------------------------------------------------------------------
// Probe 10 — global npm `jdcodec` install at a different version
// ---------------------------------------------------------------------

/**
 * Detects a globally-installed `jdcodec` (via `npm install -g`) at a
 * version that disagrees with the running connector. This is the
 * silent-shadowing failure mode where `npx jdcodec` (with no version
 * spec) finds the global install first and uses it, instead of
 * fetching the latest from the registry. The shadowed-old binary
 * may pre-date features the customer expected to have, producing
 * confusing errors that look like configuration problems but are
 * really version-shadow problems.
 *
 * Warns when:
 *   - npm is on PATH (else we can't probe)
 *   - `npm ls -g --depth=0 --json` lists `jdcodec`
 *   - the listed version is not the same as the running connector
 *
 * Best-effort: any spawn / parse failure is silently downgraded to
 * an "ok" with `npm not probed` — we don't want this probe to be
 * the source of false alarms when it's the diagnostic that's broken.
 */
export async function probeGlobalNpmConflict(
  whichNpm: string | null,
  spawnAsync: (cmd: string, args: string[], timeoutMs: number) => Promise<SpawnResult>,
  runningVersion: string,
): Promise<CheckResult> {
  if (!whichNpm) {
    return {
      name: "Global npm install",
      status: "ok",
      detail: "npm not on PATH (skipped)",
    };
  }
  let result: SpawnResult;
  try {
    result = await spawnAsync(
      "npm",
      ["ls", "-g", "--depth=0", "--json"],
      8_000,
    );
  } catch {
    return {
      name: "Global npm install",
      status: "ok",
      detail: "npm ls failed (skipped)",
    };
  }
  if (result.timedOut || !result.stdout.trim()) {
    return {
      name: "Global npm install",
      status: "ok",
      detail: "npm ls produced no output (skipped)",
    };
  }
  let parsed: { dependencies?: Record<string, { version?: string }> };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      name: "Global npm install",
      status: "ok",
      detail: "npm ls output unparseable (skipped)",
    };
  }
  const globalEntry = parsed.dependencies?.jdcodec;
  if (!globalEntry) {
    return {
      name: "Global npm install",
      status: "ok",
      detail: "no global jdcodec",
    };
  }
  const globalVersion = globalEntry.version;
  if (typeof globalVersion !== "string") {
    return {
      name: "Global npm install",
      status: "warn",
      detail: "global jdcodec exists but version is unreadable",
      hint:
        "A globally-installed jdcodec was detected but its version couldn't be read. " +
        "If you're seeing unexpected behaviour, run `npm uninstall -g jdcodec` to remove it.",
      docsLink: DOCS.setup,
    };
  }
  if (globalVersion === runningVersion) {
    return {
      name: "Global npm install",
      status: "ok",
      detail: `global jdcodec@${globalVersion} matches running version`,
    };
  }
  return {
    name: "Global npm install",
    status: "warn",
    detail: `global jdcodec@${globalVersion} ≠ running ${runningVersion}`,
    hint:
      `A globally-installed jdcodec@${globalVersion} can shadow the latest version ` +
      `when other tools (notably npx) resolve bare \`jdcodec\`. To remove the global ` +
      `install and let npx fetch the latest from the registry:\n` +
      `  npm uninstall -g jdcodec`,
    docsLink: DOCS.setup,
  };
}

// ---------------------------------------------------------------------
// Default IO implementations
// ---------------------------------------------------------------------

function defaultWhich(cmd: string): string | null {
  try {
    const result = spawnSync("which", [cmd], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim() || null;
    return null;
  } catch {
    return null;
  }
}

function defaultWhichAll(cmd: string): string[] {
  try {
    const result = spawnSync("which", ["-a", cmd], { encoding: "utf8" });
    if (result.status !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function defaultSpawnAsync(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr || err.message, timedOut });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function defaultReadFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------

const STATUS_BADGE: Record<CheckStatus, string> = {
  ok: "[ ok ]",
  warn: "[warn]",
  fail: "[fail]",
};

function colourBadge(status: CheckStatus): string {
  if (status === "ok") return palette.success(STATUS_BADGE.ok);
  if (status === "warn") return palette.warning(STATUS_BADGE.warn);
  return palette.danger(STATUS_BADGE.fail);
}

export function renderCheck(result: CheckResult, display: DisplayIO): void {
  const badge = colourBadge(result.status);
  display.print(`${badge} ${palette.bold(result.name)}: ${result.detail}`);
  if (result.hint) {
    for (const line of result.hint.split("\n")) {
      display.print(`       ${palette.dim(line)}`);
    }
  }
  if (result.docsLink) {
    display.print(`       ${palette.dim("docs:")} ${palette.cyanUnderline(result.docsLink)}`);
  }
}

export function summariseExitCode(results: CheckResult[]): number {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

export async function runDoctor(opts: DoctorIO = {}): Promise<number> {
  const display = opts.display ?? defaultDisplay;
  const processVersions = opts.processVersions ?? process.versions;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const which = opts.which ?? defaultWhich;
  const whichAll = opts.whichAll ?? defaultWhichAll;
  const spawnAsync = opts.spawnAsync ?? defaultSpawnAsync;
  const readFile = opts.readFile ?? defaultReadFile;
  const configPath =
    opts.configPath ?? join(homedir(), ".jdcodec", "config.json");
  const apiKeyEnv = opts.apiKeyEnv ?? process.env.JDC_API_KEY;
  const cloudUrl =
    opts.cloudUrl ??
    (process.env.JDC_CLOUD_URL ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const generateRequestId =
    opts.generateRequestId ?? (() => crypto.randomUUID());

  display.print(palette.bold("jdcodec doctor"));
  display.print(palette.dim(`endpoint  ${cloudUrl}`));
  display.print("");

  const results: CheckResult[] = [];

  const r1 = probeNodeVersion(processVersions.node);
  renderCheck(r1, display);
  results.push(r1);

  const r2 = probeNpx(which("npx"));
  renderCheck(r2, display);
  results.push(r2);

  const r3 = await probePlaywrightMcp(spawnAsync);
  renderCheck(r3, display);
  results.push(r3);

  const r4 = probeConnectorVersion();
  renderCheck(r4, display);
  results.push(r4);

  const cfg = probeConfigFile(configPath, apiKeyEnv, readFile);
  renderCheck(cfg.result, display);
  results.push(cfg.result);

  const r6 = probeKeyShape(cfg.apiKey);
  renderCheck(r6, display);
  results.push(r6);

  // Cloud probe is skipped if the key shape is broken — sending an
  // obviously-invalid bearer wastes a round-trip and adds noise.
  if (r6.status === "ok") {
    const r7 = await probeCloudAuth({
      cloudUrl,
      apiKey: cfg.apiKey,
      fetchImpl,
      generateRequestId,
    });
    renderCheck(r7, display);
    results.push(r7);
  } else {
    const skipped: CheckResult = {
      name: "Cloud auth",
      status: "fail",
      detail: "skipped — key shape failed above",
      docsLink: DOCS.apiKeys,
    };
    renderCheck(skipped, display);
    results.push(skipped);
  }

  const r8 = probeNpmGlobalPath(pathEnv);
  renderCheck(r8, display);
  results.push(r8);

  const r9 = probeMultipleBinaries(whichAll("jdcodec"));
  renderCheck(r9, display);
  results.push(r9);

  const r10 = await probeGlobalNpmConflict(which("npm"), spawnAsync, VERSION);
  renderCheck(r10, display);
  results.push(r10);

  display.print("");
  const exitCode = summariseExitCode(results);
  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  if (failures === 0 && warnings === 0) {
    display.print(palette.success("All checks passed."));
  } else if (failures === 0) {
    display.print(
      palette.success("All required checks passed") +
        " (" +
        palette.warning(`${warnings} warning${warnings === 1 ? "" : "s"}`) +
        ").",
    );
  } else {
    display.print(
      palette.danger(`${failures} failed`) +
        ", " +
        palette.warning(`${warnings} warning${warnings === 1 ? "" : "s"}`) +
        ".",
    );
  }
  return exitCode;
}
