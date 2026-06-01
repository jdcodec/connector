import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { AgentLlm, LlmProvider } from "../cloud/types.js";

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
  /**
   * Privacy Shield posture. "on" (default) runs the Shield on every snapshot.
   * "off" only when explicitly disabled; any unset or malformed value resolves
   * to "on" (fail-safe). Sourced from `JDC_PRIVACY_SHIELD`, then the
   * `privacy_shield` key in `~/.jdcodec/config.json`. Distinct from `bypass`
   * (JDC_BYPASS, the codec bypass): turning the Shield off keeps the cloud path
   * active but sends the snapshot unredacted, and only together with the ack.
   */
  privacyShield: "on" | "off";
  /**
   * Deliberate acknowledgement that unredacted snapshots are intended. Required
   * in addition to `privacyShield === "off"` for bypass to engage. Sourced from
   * `JDC_PRIVACY_SHIELD_BYPASS_ACK` (truthy) or the `privacy_shield_bypass_ack`
   * key in `~/.jdcodec/config.json`. Default false.
   */
  privacyShieldBypassAck: boolean;
  /**
   * Derived: redaction is skipped only when the Shield is off AND the ack is
   * set. Both signals are required, so a single misconfiguration cannot send
   * raw text.
   */
  privacyShieldBypassEngaged: boolean;
  /**
   * Customer's agent-LLM metadata. Sourced from `JDC_LLM_PROVIDER` (+
   * optional `JDC_LLM_MODEL`) env vars; falls back to the `agent_llm`
   * key in `~/.jdcodec/config.json` if env vars are absent. Undefined
   * when neither is set — the cloud service then falls back to an
   * approximate tokenizer for usage accounting. Char metrics are
   * unaffected.
   */
  agentLlm: AgentLlm | undefined;
}

export interface ConfigSource {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  /** For testing — override the default path. */
  readFile?: (path: string) => string | null;
}

const DEFAULT_CLOUD_URL = "https://api.jdcodec.com";
const DEFAULT_PLAYWRIGHT_CMD = "npx";
const DEFAULT_PLAYWRIGHT_ARGS = ["@playwright/mcp", "--no-sandbox", "--isolated"];
const DEFAULT_TRACE_DIR = "traces";

/**
 * Verify a cloud URL is safe to send the bearer token to. Production must be
 * https; local-dev allows plain http on loopback only. Anything else (a typo,
 * a copy-paste from a debug session, a hostile env-file injection) would
 * leak the API key in cleartext.
 */
export function assertSafeCloudUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`JDC_CLOUD_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) return;
  throw new Error(
    `JDC_CLOUD_URL must use https:// (loopback http://localhost is allowed for local dev). Got: ${url}`,
  );
}

export function loadConfig(source: ConfigSource = {}): ConnectorConfig {
  const env = source.env ?? process.env;
  const configPath = source.configPath ?? join(homedir(), ".jdcodec", "config.json");
  const readFile = source.readFile ?? defaultReadFile;

  const apiKey = resolveApiKey(env, configPath, readFile);
  const cloudUrl = (env.JDC_CLOUD_URL ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
  assertSafeCloudUrl(cloudUrl);
  const bypass = isTruthy(env.JDC_BYPASS);
  const region = env.JDC_REGION && env.JDC_REGION.trim() !== "" ? env.JDC_REGION : undefined;
  const playwrightCmd = env.JDC_PLAYWRIGHT_CMD ?? DEFAULT_PLAYWRIGHT_CMD;
  const playwrightArgs = env.JDC_PLAYWRIGHT_ARGS
    ? env.JDC_PLAYWRIGHT_ARGS.split(/\s+/).filter(Boolean)
    : [...DEFAULT_PLAYWRIGHT_ARGS];
  const traceEnabled = isTruthy(env.JDC_TRACE);
  const traceDir = env.JDC_TRACE_DIR ?? DEFAULT_TRACE_DIR;
  const failOpen = isTruthy(env.JDC_PRIVACY_FAIL_OPEN);
  const privacyShield = resolvePrivacyShield(env, configPath, readFile);
  const privacyShieldBypassAck = resolvePrivacyShieldBypassAck(env, configPath, readFile);
  const privacyShieldBypassEngaged = privacyShield === "off" && privacyShieldBypassAck;
  const agentLlm = resolveAgentLlm(env, configPath, readFile);

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
    privacyShield,
    privacyShieldBypassAck,
    privacyShieldBypassEngaged,
    agentLlm,
  };
}

const VALID_PROVIDERS: ReadonlySet<LlmProvider> = new Set<LlmProvider>([
  "anthropic",
  "openai",
  "gemini",
]);

/**
 * Resolve agent-LLM metadata. Same env-first, config-file-fallback
 * shape as `resolveApiKey`. Malformed entries (unknown provider, wrong
 * type) downgrade to `undefined` rather than throw — the connector's
 * snapshot path must keep working even if the customer fat-fingered
 * the env var.
 */
function resolveAgentLlm(
  env: NodeJS.ProcessEnv,
  configPath: string,
  readFile: (path: string) => string | null,
): AgentLlm | undefined {
  const envProvider = (env.JDC_LLM_PROVIDER ?? "").trim().toLowerCase();
  if (envProvider !== "") {
    if (!VALID_PROVIDERS.has(envProvider as LlmProvider)) {
      // Unknown provider name — surface visibly via the log on next
      // snapshot rather than silently dropping. The caller knows to
      // emit the warn-line; here we treat it as "not configured".
      return undefined;
    }
    const provider = envProvider as LlmProvider;
    const model = env.JDC_LLM_MODEL?.trim();
    return model && model.length > 0 ? { provider, model } : { provider };
  }

  // Env not set — try the config file.
  const raw = readFile(configPath);
  if (raw === null) return undefined;
  let parsed: { agent_llm?: unknown };
  try {
    parsed = JSON.parse(raw) as { agent_llm?: unknown };
  } catch {
    return undefined;
  }
  const fromFile = parsed.agent_llm;
  if (typeof fromFile !== "object" || fromFile === null || Array.isArray(fromFile)) {
    return undefined;
  }
  const fileObj = fromFile as Record<string, unknown>;
  const fileProvider = typeof fileObj.provider === "string" ? fileObj.provider.toLowerCase() : "";
  if (!VALID_PROVIDERS.has(fileProvider as LlmProvider)) return undefined;
  const out: AgentLlm = { provider: fileProvider as LlmProvider };
  if (typeof fileObj.model === "string" && fileObj.model.trim().length > 0) {
    out.model = fileObj.model.trim();
  }
  return out;
}

/**
 * Resolve the Privacy Shield posture with a fail-safe bias: only the exact
 * (case-insensitive) string "off" disables the Shield. Anything else, including
 * unset or malformed values, keeps it on. `JDC_PRIVACY_SHIELD` is read first;
 * only when it is unset/blank does the config-file `privacy_shield` key apply.
 */
function resolvePrivacyShield(
  env: NodeJS.ProcessEnv,
  configPath: string,
  readFile: (path: string) => string | null,
): "on" | "off" {
  const fromEnv = env.JDC_PRIVACY_SHIELD;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv.trim().toLowerCase() === "off" ? "off" : "on";
  }

  // Env unset — try the config file.
  const raw = readFile(configPath);
  if (raw === null) return "on";
  try {
    const parsed = JSON.parse(raw) as { privacy_shield?: unknown };
    if (
      typeof parsed.privacy_shield === "string" &&
      parsed.privacy_shield.trim().toLowerCase() === "off"
    ) {
      return "off";
    }
  } catch {
    return "on";
  }
  return "on";
}

/**
 * Resolve the bypass acknowledgement. `JDC_PRIVACY_SHIELD_BYPASS_ACK` (truthy)
 * OR the config-file `privacy_shield_bypass_ack === true` enables it; default
 * false. The acknowledgement on its own never engages bypass — it must be
 * paired with `privacyShield === "off"`.
 */
function resolvePrivacyShieldBypassAck(
  env: NodeJS.ProcessEnv,
  configPath: string,
  readFile: (path: string) => string | null,
): boolean {
  if (isTruthy(env.JDC_PRIVACY_SHIELD_BYPASS_ACK)) return true;

  const raw = readFile(configPath);
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw) as { privacy_shield_bypass_ack?: unknown };
    return parsed.privacy_shield_bypass_ack === true;
  } catch {
    return false;
  }
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
