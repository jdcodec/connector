import type { RedactionStats } from "../privacy/types.js";

export type FrameType = "I" | "P" | "P-nochange" | "pass-through";

/**
 * The downstream LLM provider the customer's agent is calling. Used by
 * the cloud service to pick the correct tokenizer family for token-aware
 * usage accounting. Three values today (anthropic / openai / gemini);
 * customers on aggregators (Bedrock, Vertex, OpenRouter, Azure, Together,
 * Fireworks) set this to the *underlying model's* tokenizer family —
 * the aggregator does not tokenize, the model does. Claude on Bedrock or
 * Vertex → `"anthropic"`; OpenAI on Azure → `"openai"`; etc.
 */
export type LlmProvider = "anthropic" | "openai" | "gemini";

/**
 * Customer's agent-LLM metadata, sent on every `/v1/snapshot` request.
 * The cloud service stores it on the session on the first snapshot and
 * ignores subsequent values (first-wins) — so the connector can send it
 * every request without tracking per-session state. When omitted, the
 * cloud falls back to an approximate tokenizer and the resulting usage
 * rows carry that fact explicitly.
 */
export interface AgentLlm {
  provider: LlmProvider;
  /**
   * Optional model identifier, e.g. `"claude-sonnet-4-6"`, `"gpt-4o"`,
   * `"gemini-2.5-pro"`. Refines tokenizer-version selection when the
   * provider supports multiple tokenizers (e.g. some model generations
   * tokenize the same text differently from earlier generations).
   */
  model?: string;
}

export interface SnapshotRequest {
  session_id: string;
  task_id: string;
  step: number;
  url: string;
  snapshot_yaml: string;
  /**
   * True when the connector redacted PII before sending. False only on the
   * deliberate unredacted-send path, which must also set `privacy_shield_bypass`.
   */
  client_redacted: boolean;
  redaction_stats: RedactionStats;
  /**
   * Set true alongside `client_redacted: false` to opt into an unredacted send.
   * Optional and additive: omitting it (the default path) is unchanged
   * behaviour. `redaction_stats` is `{}` when this is true.
   */
  privacy_shield_bypass?: boolean;
  /**
   * Optional — the cloud service only acts on it on the first snapshot
   * of a session. Source: `JDC_LLM_PROVIDER` env (or `agent_llm` key in
   * `~/.jdcodec/config.json`).
   */
  agent_llm?: AgentLlm;
}

export interface SnapshotResponse {
  frame_type: FrameType;
  compressed_output?: string;
  compression_stats: {
    input_chars: number;
    output_chars: number;
    codec_ms: number;
  };
}

export type CloudErrorCode =
  | "version_unsupported"
  | "malformed_request"
  | "privacy_shield_missing"
  | "privacy_shield_structural"
  | "privacy_shield_violation"
  | "step_out_of_order"
  | "auth_missing"
  | "auth_invalid"
  | "auth_revoked"
  | "quota_exceeded"
  | "session_expired"
  | "payload_too_large"
  | "rate_limited"
  | "server_error"
  | "codec_overloaded"
  | "telemetry_value_invalid"
  | "telemetry_session_unknown"
  | "telemetry_too_late";

/**
 * Body of POST /v1/telemetry. All timing fields optional — connector sends
 * what it measured, omits what it didn't. Three components are designed to
 * be additive: client_round_trip_ms ≈ redaction_ms + cloud_ms + upstream_ms;
 * residual surfaces in queries as a data-quality signal (untracked overhead).
 */
export interface TelemetryRequest {
  session_id: string;
  step: number;
  client_round_trip_ms?: number;
  redaction_ms?: number;
  cloud_ms?: number;
  upstream_ms?: number;
  connector_version?: string;
}
