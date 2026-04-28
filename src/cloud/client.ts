import { CloudNetworkError, CloudRequestError } from "./errors.js";
import type {
  CloudErrorCode,
  SnapshotRequest,
  SnapshotResponse,
} from "./types.js";

export const DEFAULT_CLOUD_URL = "https://api.jdcodec.com";
export const SNAPSHOT_PATH = "/v1/snapshot";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 1;

const API_VERSION = "1";

export interface CloudClientOptions {
  baseUrl?: string;
  apiKey: string;
  timeoutMs?: number;
  retries?: number;
  region?: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  now?: () => number;
  /** Override for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override for tests — used for X-Request-Id. */
  generateRequestId?: () => string;
}

export interface CloudPostResult {
  response: SnapshotResponse;
  requestId: string;
  httpStatus: number;
  elapsedMs: number;
}

export class CloudClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly region: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly generateRequestId: () => string;

  constructor(opts: CloudClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.region = opts.region;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => performance.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.generateRequestId = opts.generateRequestId ?? (() => crypto.randomUUID());
  }

  async postSnapshot(body: SnapshotRequest): Promise<CloudPostResult> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.retries) {
      try {
        return await this.postOnce(body);
      } catch (err) {
        lastErr = err;
        if (err instanceof CloudRequestError && !err.isTransient) throw err;
        if (attempt === this.retries) break;
        const backoffMs = 250 * Math.pow(2, attempt);
        await this.sleep(backoffMs);
        attempt++;
      }
    }
    throw lastErr instanceof Error ? lastErr : new CloudNetworkError("unknown error", lastErr);
  }

  private async postOnce(body: SnapshotRequest): Promise<CloudPostResult> {
    const requestId = this.generateRequestId();
    const url = `${this.baseUrl}${SNAPSHOT_PATH}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-JDC-API-Version": API_VERSION,
      "X-Request-Id": requestId,
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.region) headers["X-JDC-Region"] = this.region;

    const start = this.now();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      throw new CloudNetworkError(
        (err as Error)?.name === "AbortError" ? "request timeout" : "network error",
        err,
      );
    }
    clearTimeout(timeoutHandle);

    const elapsedMs = this.now() - start;
    const echoedRequestId = res.headers.get("x-request-id") ?? requestId;

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new CloudRequestError(
        res.status,
        res.status >= 500 ? "server_error" : "malformed_request",
        "cloud returned non-JSON response",
        echoedRequestId,
      );
    }

    if (!res.ok) {
      throw cloudErrorFromBody(res.status, parsed, echoedRequestId);
    }

    return {
      response: parsed as SnapshotResponse,
      requestId: echoedRequestId,
      httpStatus: res.status,
      elapsedMs,
    };
  }
}

function cloudErrorFromBody(
  status: number,
  body: unknown,
  requestId: string,
): CloudRequestError {
  const errorField = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
  const code = (errorField?.code ?? defaultCodeForStatus(status)) as CloudErrorCode;
  const message = errorField?.message ?? `cloud returned ${status}`;
  return new CloudRequestError(status, code, message, requestId);
}

function defaultCodeForStatus(status: number): CloudErrorCode {
  if (status === 401) return "auth_invalid";
  if (status === 410) return "session_expired";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limited";
  if (status === 503) return "codec_overloaded";
  if (status >= 500) return "server_error";
  return "malformed_request";
}
