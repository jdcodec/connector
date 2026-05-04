import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

/**
 * Stable per-installation identifier, persisted on first run.
 *
 * Read from `~/.jdcodec/machine-id` if present. Otherwise derive from
 * the hostname and the first non-internal network MAC, hash, persist
 * (mode 0600), and return. Persisting matters because the MAC-lookup
 * fallback can shift between runs in sandboxed environments — without
 * the file, the derivation would re-randomise on the affected systems
 * and defeat client-side dedup.
 *
 * The `py-node-` prefix is part of the file format and stays stable
 * across releases. Other JD Codec clients on the same machine read the
 * same file; rebranding the prefix would invalidate existing IDs and
 * fragment a single user across multiple identifiers.
 *
 * Telemetry-only — not a credential. The file is written 0600 as a
 * defensive default; on Windows `chmod` is a no-op (acceptable).
 */
export const MACHINE_ID_PATH = join(homedir(), ".jdcodec", "machine-id");

export interface MachineIdSource {
  /** Override for tests. */
  path?: string;
  /** Override hostname for tests. */
  hostname?: () => string;
  /** Override network interfaces for tests. */
  networkInterfaces?: () => ReturnType<typeof networkInterfaces>;
}

export function stableMachineId(source: MachineIdSource = {}): string {
  const path = source.path ?? MACHINE_ID_PATH;

  if (existsSync(path)) {
    try {
      const cached = readFileSync(path, "utf8").trim();
      if (cached) return cached;
    } catch {
      // fall through to derive + persist
    }
  }

  const host = (source.hostname ?? hostname)();
  const mac = firstNonInternalMac(source.networkInterfaces ?? networkInterfaces);
  const seed = `${host}|${mac}`;
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  const mid = `py-node-${digest}`;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, mid, "utf8");
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows / restricted env — chmod best-effort. The file isn't a
      // credential, so a permissive mode is acceptable.
    }
  } catch {
    // Read-only home / sandboxed env — fall back to the in-process
    // value. Caller still gets a stable id within a single invocation.
  }

  return mid;
}

function firstNonInternalMac(nics: () => ReturnType<typeof networkInterfaces>): string {
  const ifs = nics() ?? {};
  for (const name of Object.keys(ifs).sort()) {
    const entries = ifs[name];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal) continue;
      if (!entry.mac || entry.mac === "00:00:00:00:00:00") continue;
      return entry.mac;
    }
  }
  // No usable MAC — fall back to a random 48-bit value. The persisted
  // file pins this on first run so subsequent invocations reuse the
  // same id rather than re-randomising.
  return randomMac();
}

function randomMac(): string {
  const bytes: string[] = [];
  for (let i = 0; i < 6; i++) {
    bytes.push(Math.floor(Math.random() * 256).toString(16).padStart(2, "0"));
  }
  return bytes.join(":");
}
