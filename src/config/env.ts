import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export interface ConnectorConfig {
  apiKey: string | null;
  cloudUrl: string;
  bypass: boolean;
  region: string | undefined;
  playwrightCmd: string;
  playwrightArgs: string[];
  traceEnabled: boolean;
  traceDir: string;
  failOpen: boolean;
}

export interface ConfigSource {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  /** For testing — override the default path. */
  readFile?: (path: string) => string | null;
}

const DEFAULT_CLOUD_URL = "https://api.jdcodec.com";
const DEFAULT_PLAYWRIGHT_CMD = "npx";
const DEFAULT_PLAYWRIGHT_ARGS = ["@playwright/mcp", "--no-sandbox"];
const DEFAULT_TRACE_DIR = "traces";

export function loadConfig(source: ConfigSource = {}): ConnectorConfig {
  const env = source.env ?? process.env;
  const configPath = source.configPath ?? join(homedir(), ".jdcodec", "config.json");
  const readFile = source.readFile ?? defaultReadFile;

  const apiKey = resolveApiKey(env, configPath, readFile);
  const cloudUrl = (env.JDC_CLOUD_URL ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
  const bypass = isTruthy(env.JDC_BYPASS);
  const region = env.JDC_REGION && env.JDC_REGION.trim() !== "" ? env.JDC_REGION : undefined;
  const playwrightCmd = env.JDC_PLAYWRIGHT_CMD ?? DEFAULT_PLAYWRIGHT_CMD;
  const playwrightArgs = env.JDC_PLAYWRIGHT_ARGS
    ? env.JDC_PLAYWRIGHT_ARGS.split(/\s+/).filter(Boolean)
    : [...DEFAULT_PLAYWRIGHT_ARGS];
  const traceEnabled = isTruthy(env.JDC_TRACE);
  const traceDir = env.JDC_TRACE_DIR ?? DEFAULT_TRACE_DIR;
  const failOpen = isTruthy(env.JDC_PRIVACY_FAIL_OPEN);

  return {
    apiKey,
    cloudUrl,
    bypass,
    region,
    playwrightCmd,
    playwrightArgs,
    traceEnabled,
    traceDir,
    failOpen,
  };
}

function resolveApiKey(
  env: NodeJS.ProcessEnv,
  configPath: string,
  readFile: (path: string) => string | null,
): string | null {
  const fromEnv = env.JDC_API_KEY;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();

  const raw = readFile(configPath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { api_key?: string };
    if (typeof parsed.api_key === "string" && parsed.api_key.trim() !== "") {
      return parsed.api_key.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function defaultReadFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const lower = v.trim().toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes";
}
