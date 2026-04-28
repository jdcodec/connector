import type { CloudErrorCode } from "./types.js";

export class CloudRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: CloudErrorCode,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "CloudRequestError";
  }

  /** Terminal errors cannot be recovered by retry; caller should surface to the agent. */
  get isTerminal(): boolean {
    switch (this.code) {
      case "version_unsupported":
      case "malformed_request":
      case "privacy_shield_missing":
      case "privacy_shield_structural":
      case "privacy_shield_violation":
      case "auth_missing":
      case "auth_invalid":
      case "auth_revoked":
      case "quota_exceeded":
      case "payload_too_large":
        return true;
      default:
        return false;
    }
  }

  /** Transient errors can be retried (5xx, 429, network). */
  get isTransient(): boolean {
    switch (this.code) {
      case "server_error":
      case "codec_overloaded":
      case "rate_limited":
        return true;
      default:
        return false;
    }
  }
}

export class CloudNetworkError extends Error {
  readonly code = "network_error" as const;

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "CloudNetworkError";
  }
}
