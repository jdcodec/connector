import type { RedactionStats } from "../privacy/types.js";

export type FrameType = "I" | "P" | "P-nochange" | "pass-through";

export interface SnapshotRequest {
  session_id: string;
  task_id: string;
  step: number;
  url: string;
  snapshot_yaml: string;
  client_redacted: true;
  redaction_stats: RedactionStats;
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
