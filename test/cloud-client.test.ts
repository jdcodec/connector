import { describe, it, expect } from "vitest";
import { CloudClient } from "../src/cloud/client.js";
import { CloudNetworkError, CloudRequestError } from "../src/cloud/errors.js";
import type { SnapshotRequest } from "../src/cloud/types.js";

function makeRequest(overrides: Partial<SnapshotRequest> = {}): SnapshotRequest {
  return {
    session_id: "9c1b2f6e-0b8e-4a77-9cfd-3e3f7b5e8d21",
    task_id: "a7d19e44-31f6-4a02-8f9b-0c2a5fbc11d3",
    step: 0,
    url: "https://example.com/",
    snapshot_yaml: "- role: main",
    client_redacted: true,
    redaction_stats: {},
    ...overrides,
  };
}

function mockFetch(
  handler: (req: Request) => Promise<Response> | Response,
): { fetchImpl: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input as string, init as RequestInit);
    calls.push(req);
    return handler(req);
  };
  return { fetchImpl, calls };
}

describe("CloudClient — happy path", () => {
  it("posts to /v1/snapshot with required headers and returns the response", async () => {
    const { fetchImpl, calls } = mockFetch(async () => {
      return new Response(
        JSON.stringify({
          frame_type: "I",
          compressed_output: "compressed",
          compression_stats: { input_chars: 12, output_chars: 10, codec_ms: 1 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json", "x-request-id": "abc-123" },
        },
      );
    });

    const client = new CloudClient({
      baseUrl: "https://api.example.test",
      apiKey: "jdck_id.secret",
      fetchImpl,
      generateRequestId: () => "generated-uuid",
      sleep: async () => {},
    });

    const result = await client.postSnapshot(makeRequest());

    expect(result.response.frame_type).toBe("I");
    expect(result.response.compressed_output).toBe("compressed");
    expect(result.requestId).toBe("abc-123");

    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.url).toBe("https://api.example.test/v1/snapshot");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer jdck_id.secret");
    expect(req.headers.get("x-jdc-api-version")).toBe("1");
    expect(req.headers.get("x-request-id")).toBe("generated-uuid");
    expect(req.headers.get("content-type")).toBe("application/json");
  });

  it("sends X-JDC-Region when region option is set", async () => {
    const { fetchImpl, calls } = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            frame_type: "I",
            compression_stats: { input_chars: 1, output_chars: 1, codec_ms: 1 },
            compressed_output: "x",
          }),
          { status: 200 },
        ),
    );
    const client = new CloudClient({
      apiKey: "jdck_id.secret",
      fetchImpl,
      region: "oc",
      sleep: async () => {},
    });
    await client.postSnapshot(makeRequest());
    expect(calls[0].headers.get("x-jdc-region")).toBe("oc");
  });
});

describe("CloudClient — error taxonomy mapping", () => {
  it("maps 401 auth_invalid to a terminal CloudRequestError", async () => {
    const { fetchImpl } = mockFetch(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "auth_invalid", message: "bad key" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new CloudClient({ apiKey: "jdck_id.secret", fetchImpl, sleep: async () => {} });
    await expect(client.postSnapshot(makeRequest())).rejects.toMatchObject({
      name: "CloudRequestError",
      status: 401,
      code: "auth_invalid",
    });
  });

  it("maps 410 session_expired to a terminal code (connector must rotate session)", async () => {
    const { fetchImpl } = mockFetch(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "session_expired", message: "expired" } }),
          { status: 410, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new CloudClient({ apiKey: "jdck_id.secret", fetchImpl, sleep: async () => {} });
    let caught: unknown;
    try {
      await client.postSnapshot(makeRequest());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloudRequestError);
    const e = caught as CloudRequestError;
    expect(e.code).toBe("session_expired");
    expect(e.status).toBe(410);
    // session_expired is not in the isTransient set — connector rotates the session,
    // doesn't retry the same session blindly.
    expect(e.isTransient).toBe(false);
  });

  it("maps 413 payload_too_large — terminal (degraded path handles it)", async () => {
    const { fetchImpl } = mockFetch(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "payload_too_large", message: "too big" } }),
          { status: 413, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new CloudClient({ apiKey: "jdck_id.secret", fetchImpl, sleep: async () => {} });
    let caught: unknown;
    try {
      await client.postSnapshot(makeRequest());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloudRequestError);
    expect((caught as CloudRequestError).isTerminal).toBe(true);
  });
});

describe("CloudClient — retry behaviour", () => {
  it("retries once on 500 then succeeds", async () => {
    let call = 0;
    const { fetchImpl, calls } = mockFetch(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ error: { code: "server_error", message: "oops" } }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          frame_type: "P",
          compressed_output: "ok",
          compression_stats: { input_chars: 1, output_chars: 1, codec_ms: 1 },
        }),
        { status: 200 },
      );
    });
    const client = new CloudClient({
      apiKey: "jdck_id.secret",
      fetchImpl,
      retries: 1,
      sleep: async () => {},
    });
    const result = await client.postSnapshot(makeRequest());
    expect(result.response.frame_type).toBe("P");
    expect(calls.length).toBe(2);
  });

  it("does NOT retry on terminal 4xx", async () => {
    let call = 0;
    const { fetchImpl, calls } = mockFetch(async () => {
      call++;
      return new Response(
        JSON.stringify({ error: { code: "auth_invalid", message: "bad" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });
    const client = new CloudClient({
      apiKey: "jdck_id.secret",
      fetchImpl,
      retries: 3,
      sleep: async () => {},
    });
    await expect(client.postSnapshot(makeRequest())).rejects.toBeInstanceOf(CloudRequestError);
    expect(calls.length).toBe(1);
  });

  it("maps network error to CloudNetworkError and retries it", async () => {
    let call = 0;
    const { fetchImpl, calls } = mockFetch(async () => {
      call++;
      if (call === 1) throw new Error("ECONNREFUSED");
      return new Response(
        JSON.stringify({
          frame_type: "P",
          compressed_output: "ok",
          compression_stats: { input_chars: 1, output_chars: 1, codec_ms: 1 },
        }),
        { status: 200 },
      );
    });
    const client = new CloudClient({
      apiKey: "jdck_id.secret",
      fetchImpl,
      retries: 1,
      sleep: async () => {},
    });
    const result = await client.postSnapshot(makeRequest());
    expect(result.response.frame_type).toBe("P");
    expect(calls.length).toBe(2);
  });

  it("gives up after retries exhausted", async () => {
    const { fetchImpl, calls } = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new CloudClient({
      apiKey: "jdck_id.secret",
      fetchImpl,
      retries: 2,
      sleep: async () => {},
    });
    await expect(client.postSnapshot(makeRequest())).rejects.toBeInstanceOf(CloudNetworkError);
    expect(calls.length).toBe(3);
  });
});

describe("CloudClient — body shape", () => {
  it("serialises the full contract §4.2 body", async () => {
    let captured: SnapshotRequest | undefined;
    const { fetchImpl } = mockFetch(async (req) => {
      captured = JSON.parse(await req.text()) as SnapshotRequest;
      return new Response(
        JSON.stringify({
          frame_type: "I",
          compressed_output: "",
          compression_stats: { input_chars: 0, output_chars: 0, codec_ms: 0 },
        }),
        { status: 200 },
      );
    });
    const client = new CloudClient({ apiKey: "jdck_id.secret", fetchImpl, sleep: async () => {} });
    const body = makeRequest({
      url: "https://app.example.com/u/1",
      snapshot_yaml: "- heading {{REDACTED_EMAIL}}",
      redaction_stats: { EMAIL: 1 },
      step: 3,
    });
    await client.postSnapshot(body);

    expect(captured).toMatchObject({
      session_id: body.session_id,
      task_id: body.task_id,
      step: 3,
      url: "https://app.example.com/u/1",
      snapshot_yaml: "- heading {{REDACTED_EMAIL}}",
      client_redacted: true,
      redaction_stats: { EMAIL: 1 },
    });
  });
});
