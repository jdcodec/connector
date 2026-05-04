import { defaultDisplay, DisplayIO, DOCS_URL, LOGO_ASCII, palette } from "./display.js";
import { runAudit } from "./audit.js";
import { runDoctor } from "./doctor.js";
import { runLogin } from "./login.js";
import { runSetup } from "./setup.js";
import { VERSION } from "./version.js";

// Re-export so existing consumers (`src/index.ts`, tests) that imported
// DOCS_URL from this module continue to work after the constant moved
// to `./display.js` to break a circular import with `./doctor.js`.
export { DOCS_URL };

/**
 * Subcommands handled by the onboarding surface — `start`, `login`,
 * `audit`, `doctor`, and `setup` route to one-shot interactive flows
 * that exit before the MCP proxy starts. Anything else falls through
 * to the proxy in `src/index.ts`.
 */
export const ONBOARDING_COMMANDS = new Set(["start", "login", "audit", "doctor", "setup"]);

export const HELP_FLAGS = new Set(["--help", "-h", "help"]);
export const VERSION_FLAGS = new Set(["--version", "-v", "version"]);

export function isOnboardingCommand(arg: string | undefined): boolean {
  return arg !== undefined && ONBOARDING_COMMANDS.has(arg);
}

export function isHelpFlag(arg: string | undefined): boolean {
  return arg !== undefined && HELP_FLAGS.has(arg);
}

export function isVersionFlag(arg: string | undefined): boolean {
  return arg !== undefined && VERSION_FLAGS.has(arg);
}

export async function runOnboarding(
  args: string[],
  display: DisplayIO = defaultDisplay,
): Promise<number> {
  const cmd = args[0];
  if (cmd === "start" || cmd === "login") {
    return runLogin({ display });
  }
  if (cmd === "audit") {
    return runAudit({ display });
  }
  if (cmd === "doctor") {
    return runDoctor({ display });
  }
  if (cmd === "setup") {
    return runSetup(args, { display });
  }
  printHelp(display);
  return 0;
}

export function printHelp(display: DisplayIO = defaultDisplay): void {
  display.print(palette.info(LOGO_ASCII));
  display.print("");
  display.print(`${palette.bold(" JD Codec CLI")} ${palette.dim(VERSION)}`);
  display.print(" Just the deltas, nothing more.");
  display.print("");
  display.print(" Commands:");
  display.print(`  ${palette.info("start, login")}    Register your node and join the Private Alpha`);
  display.print(`  ${palette.info("audit")}           Analyze your local agent environment`);
  display.print(`  ${palette.info("doctor")}          Diagnose install, config, and cloud connectivity`);
  display.print(`  ${palette.info("setup <client>")}  Wire JD Codec MCP servers into your AI client (claude-code, cursor, windsurf, vscode)`);
  display.print(`  ${palette.info("--help, -h")}      Show this message`);
  display.print(`  ${palette.info("--version, -v")}   Show CLI version and configured cloud endpoint`);
  display.print(
    `  ${palette.dim("(no args)")}       Launch the MCP stdio proxy (requires JDC_API_KEY or JDC_BYPASS=1)`,
  );
  display.print("");
  display.print(" Usage:");
  display.print("  jdcodec start");
  display.print("  jdcodec doctor");
  display.print("  jdcodec setup <client>");
  display.print("  jdcodec audit");
  display.print("  jdcodec --version");
  display.print(`  jdcodec                ${palette.dim("# MCP stdio proxy")}`);
  display.print("");
  display.print(` Docs: ${palette.cyanUnderline(DOCS_URL)}`);
  display.print("");
}

/**
 * Prints the connector version and the cloud endpoint it's configured
 * against. Intentionally offline — `--version` should be instant and
 * never make network calls. The cloud codec build is reported by
 * `jdcodec doctor` instead, where the network round-trip is expected.
 */
export function printVersion(
  cloudUrl: string,
  display: DisplayIO = defaultDisplay,
): void {
  display.print(`jdcodec ${VERSION}`);
  display.print(`endpoint  ${cloudUrl}`);
}
