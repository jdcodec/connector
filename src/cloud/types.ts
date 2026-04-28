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
  | "codec_overloaded";
