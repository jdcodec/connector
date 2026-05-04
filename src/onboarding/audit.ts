import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { defaultDisplay, DisplayIO, palette, printLogo } from "./display.js";
import { stableMachineId } from "./machine-id.js";
import { VERSION } from "./version.js";

const API_BASE = "https://jdcodec.com/api";

export interface AuditResults {
  langchain: boolean;
  playwright: boolean;
  browser_use: boolean;
  keys_found: number;
}

export interface AuditDeps {
  apiBase?: string;
  display?: DisplayIO;
  fetch?: typeof fetch;
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  machineId?: () => string;
  /** Override scan for tests. */
  scan?: (cwd: string) => AuditResults;
  /** Sleep between banner and reporting. Real path uses 1s; tests pass 0. */
  sleep?: (ms: number) => Promise<void>;
}

export async function runAudit(deps: AuditDeps = {}): Promise<number> {
  const apiBase = deps.apiBase ?? API_BASE;
  const display = deps.display ?? defaultDisplay;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const cwd = (deps.cwd ?? process.cwd)();
  const env = deps.env ?? process.env;
  const machineId = deps.machineId ?? stableMachineId;
  const scan = deps.scan ?? scanLocalAgentEnv;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  printLogo(display);
  display.print("");
  display.print(palette.bold(palette.info(` 🚀 JD Codec v${VERSION} initializing...`)));
  display.print("");
  display.print(palette.dim(" Analyzing local agent environment..."));

  const results = scan(cwd);
  if (env.OPENAI_API_KEY) results.keys_found += 1;
  if (env.ANTHROPIC_API_KEY) results.keys_found += 1;

  await sleep(1_000);

  // Telemetry. `source: "npm"` tells the server which install channel
  // produced the audit row. Failure is non-fatal — the user still
  // gets a usable audit display below.
  try {
    await doFetch(`${apiBase}/intent-logger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machine_id: machineId(),
        source: "npm",
        audit_results: results,
      }),
    });
  } catch {
    // ignore
  }

  if (results.playwright || results.browser_use) {
    display.print(palette.success(" ✅ System Check: COMPATIBLE"));
    display.print(palette.dim(" Detected: agent framework found in this directory."));
    display.print("");
  } else {
    display.print(palette.warning(" ⚠️ System Check: PARTIAL COMPATIBILITY"));
    display.print(
      palette.dim(" Note: no active agent framework detected in current directory."),
    );
    display.print("");
  }

  display.print(` Machine ID: ${palette.white(machineId())}`);
  display.print("");
  display.print("To finish registration and join the Alpha, run:");
  display.print(palette.bold(palette.info(" jdcodec start")));
  display.print("");

  return 0;
}

function scanLocalAgentEnv(cwd: string): AuditResults {
  const results: AuditResults = {
    langchain: false,
    playwright: false,
    browser_use: false,
    keys_found: 0,
  };

  // Python projects — text scan over `requirements.txt`.
  const reqs = readIfExists(join(cwd, "requirements.txt"));
  if (reqs) {
    if (reqs.includes("langchain")) results.langchain = true;
    if (reqs.includes("playwright")) results.playwright = true;
    if (reqs.includes("browser-use")) results.browser_use = true;
  }

  // Node projects — scan `package.json` deps + devDeps. Both runtimes
  // are scanned so we don't miss either single-language project shape.
  const pkgRaw = readIfExists(join(cwd, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const names = Object.keys(all);
      if (names.some((n) => n.startsWith("langchain") || n === "@langchain/core")) {
        results.langchain = true;
      }
      if (names.some((n) => n === "playwright" || n.startsWith("@playwright/"))) {
        results.playwright = true;
      }
      if (names.includes("browser-use")) {
        results.browser_use = true;
      }
    } catch {
      // malformed package.json — leave results unchanged
    }
  }

  return results;
}

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
