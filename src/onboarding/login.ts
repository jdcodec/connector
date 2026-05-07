import { randomBytes } from "node:crypto";

import { CONSENT_TEXT, defaultDisplay, DisplayIO, palette, printLogo } from "./display.js";
import { stableMachineId } from "./machine-id.js";

const API_BASE = "https://jdcodec.com/api";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 300_000;
const SESSION_ID_LEN = 10;

interface PollResponse {
  status?: string;
  email?: string | null;
  waitlist_pos?: number | null;
}

export interface LoginDeps {
  apiBase?: string;
  display?: DisplayIO;
  /** Override for tests — defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Open the browser. No-op in tests. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** Wait for Enter on TTY before opening the browser. No-op in tests. */
  waitForEnter?: () => Promise<void>;
  /** Sleep between polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Generate the session id (10-char alphanumeric). Override for tests. */
  generateSessionId?: () => string;
  /** Override stable machine id (avoids touching the user's home dir in tests). */
  machineId?: () => string;
  /** Clock for poll-timeout. Override for tests. */
  now?: () => number;
}

export async function runLogin(deps: LoginDeps = {}): Promise<number> {
  const apiBase = deps.apiBase ?? API_BASE;
  const display = deps.display ?? defaultDisplay;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const waitForEnter = deps.waitForEnter ?? defaultWaitForEnter;
  const sleep = deps.sleep ?? defaultSleep;
  const generateSessionId = deps.generateSessionId ?? defaultSessionId;
  const machineId = deps.machineId ?? stableMachineId;
  const now = deps.now ?? Date.now;

  printLogo(display);
  display.print("");
  display.print(palette.bold(palette.info(" 🔐 JD Codec Cloud Authentication")));
  display.print("");

  const sessionId = generateSessionId();
  const authUrl = `https://jdcodec.com/login?sid=${sessionId}`;

  // Register the session with the backend, including the stable
  // machine ID so the server can link the OAuth-completed account row
  // to any prior environment-audit row from the same machine. Failure
  // here is non-fatal — OAuth still works, the machine_id link is
  // best-effort.
  try {
    await doFetch(`${apiBase}/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, machine_id: machineId() }),
    });
  } catch {
    // ignore
  }

  display.print(" To authenticate your local node, please visit:");
  display.print(palette.cyanUnderline(authUrl));
  display.print("");
  display.print(palette.dim(` ${CONSENT_TEXT}`));
  display.print("");
  display.print(palette.dim(" Press Enter to agree and open browser, or Ctrl+C to cancel..."));

  await waitForEnter();

  display.print(palette.info("Opening browser..."));
  try {
    await openBrowser(authUrl);
  } catch {
    // Browser open failed — user can copy the URL above manually.
  }

  let email: string | null = null;
  let waitlistPos: number | null = null;
  const start = now();

  while (now() - start < POLL_TIMEOUT_MS) {
    try {
      const res = await doFetch(`${apiBase}/auth/session?sid=${sessionId}`);
      const data = (await res.json()) as PollResponse;
      if (data.status === "completed") {
        email = data.email ?? null;
        waitlistPos = typeof data.waitlist_pos === "number" ? data.waitlist_pos : null;
        break;
      }
    } catch {
      // transient — keep polling
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (email) {
    const mid = machineId();
    display.print("");
    display.print(palette.successBold(" ✅ NODE REGISTERED "));
    display.print("");
    if (waitlistPos !== null) {
      display.print(
        ` Welcome — your waitlist position is ${palette.bold(palette.info("#" + waitlistPos))}`,
      );
    }
    display.print(` Account:    ${palette.info(email)}`);
    display.print(` Machine ID: ${palette.white(mid)}`);
    display.print("");
    display.print(palette.dim("──────────────────────────────────────────────"));
    display.print(" Want to skip the queue?");
    display.print(` Reply to ${palette.info("hello@jdcodec.com")} with what you're building.`);
    display.print(" We prioritize early users with concrete use cases.");
    display.print(palette.dim("──────────────────────────────────────────────"));
    display.print("");
    return 0;
  }

  display.print(palette.danger("Authentication timed out."));
  display.print(palette.dim("Try again with: jdcodec start"));
  display.print("");
  return 1;
}

function defaultSessionId(): string {
  // CSPRNG, not Math.random — the sid is the only secret tying the local
  // poll to the account row that completes browser-side authentication.
  // A predictable sid lets a co-resident process race the legitimate poll
  // and exfiltrate the user's email + waitlist position.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(SESSION_ID_LEN);
  let out = "";
  for (let i = 0; i < SESSION_ID_LEN; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultWaitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve();
      return;
    }
    const onData = (): void => {
      process.stdin.removeListener("data", onData);
      try {
        process.stdin.pause();
      } catch {
        // best-effort
      }
      resolve();
    };
    try {
      process.stdin.resume();
      process.stdin.once("data", onData);
    } catch {
      resolve();
    }
  });
}

async function defaultOpenBrowser(url: string): Promise<void> {
  // Cross-platform `open URL` without bringing in a dep — small enough
  // to inline. Mirrors the OS-specific commands the `open` package
  // uses, scoped to the three platforms we care about.
  const { spawn } = await import("node:child_process");
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // ignore — handled by caller printing the URL
  }
}
