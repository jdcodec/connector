import { describe, it, expect } from "vitest";
import { handleSnapshot } from "../src/proxy/snapshot.js";
import { CloudClient } from "../src/cloud/client.js";
import { CloudNetworkError, CloudRequestError } from "../src/cloud/errors.js";
import { SessionState } from "../src/session/state.js";

const RESPONSE = [
  "Page URL: https://example.com/users/jane@example.org",
  "",
  "- Page Snapshot",
  "```yaml",
  "- heading \"Hello jane@example.org\" [ref=e1]",
  "- textbox \"card\" [ref=e2]: 4111-1111-1111-1111",
  "```",
  "",
  "Tabs: 0",
].join("\n");

function stubCloud(handler: (req: unknown) => Response | Promise<Response>): CloudClient {
  return new CloudClient({
    apiKey: "jdck_id.secret",
    fetchImpl: async (_input, init) => {
      const parsed = JSON.parse((init as RequestInit).body as string);
      return handler(parsed);
    },
    sleep: async () => {},
  });
}

function makeLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  return {
    events,
    logger: {
      info: (event: string, fields?: Record<string, unknown>) => {
        events.push({ level: "info", event, fields });
      },
      warn: (event: string, fields?: Record<string, unknown>) => {
        events.push({ level: "warn", event, fields });
      },
      error: (event: string, fields?: Record<string, unknown>) => {
        events.push({ level: "error", event, fields });
      },
    },
  };
}

describe("handleSnapshot — happy path", () => {
  it("runs Privacy Shield + POSTs to cloud + returns compressed output", async () => {
    let captured: unknown;
    const cloud = stubCloud(async (req) => {
      captured = req;
      return new Response(
        JSON.stringify({
          frame_type: "I",
          compressed_output: "COMPRESSED_PAYLOAD",
          compression_stats: { input_chars: 100, output_chars: 20, codec_ms: 5 },
        }),
        { status: 200, headers: { "x-request-id": "req-1" } },
      );
    });
    const { logger } = makeLogger();

    const result = await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
      log: logger,
    });

    expect(result.outcome).toBe("compressed");
    expect(result.text).toContain("COMPRESSED_PAYLOAD");
    expect(result.text).not.toContain("jane@example.org");
    expect(result.text).not.toContain("4111-1111-1111-1111");

    expect(captured).toMatchObject({ client_redacted: true });
    const body = captured as { snapshot_yaml: string; url: string; redaction_stats: Record<string, number> };
    expect(body.snapshot_yaml).toContain("{{REDACTED_EMAIL}}");
    expect(body.snapshot_yaml).toContain("{{REDACTED_CC}}");
    expect(body.url).not.toContain("jane@example.org");
    expect(body.redaction_stats.EMAIL).toBeGreaterThanOrEqual(1);
    expect(body.redaction_stats.CC).toBeGreaterThanOrEqual(1);
  });

  it("returns pass_through outcome when server says pass-through", async () => {
    const cloud = stubCloud(
      async () =>
        new Response(
          JSON.stringify({
            frame_type: "pass-through",
            compression_stats: { input_chars: 100, output_chars: 100, codec_ms: 1 },
          }),
          { status: 200 },
        ),
    );

    const result = await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
    });

    expect(result.outcome).toBe("pass_through");
    // Pass-through: connector reuses the redacted snapshot (not the raw one)
    expect(result.text).toContain("{{REDACTED_EMAIL}}");
    expect(result.text).not.toContain("jane@example.org");
  });
});

describe("handleSnapshot — bypass + fallback", () => {
  it("bypass=true skips cloud and returns redacted snapshot", async () => {
    const cloud = stubCloud(async () => {
      throw new Error("should not be called");
    });
    const result = await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: true,
    });
    expect(result.outcome).toBe("bypass");
    expect(result.text).toContain("{{REDACTED_EMAIL}}");
    expect(result.text).not.toContain("jane@example.org");
  });

  it("cloud=null skips cloud and returns redacted snapshot", async () => {
    const result = await handleSnapshot(RESPONSE, {
      cloud: null,
      session: new SessionState(),
      bypass: false,
    });
    expect(result.outcome).toBe("bypass");
    expect(result.text).not.toContain("jane@example.org");
  });

  it("network error → degraded path with redacted snapshot", async () => {
    const cloud = new CloudClient({
      apiKey: "jdck_id.secret",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      retries: 0,
      sleep: async () => {},
    });
    const { events, logger } = makeLogger();
    const result = await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
      log: logger,
    });
    expect(result.outcome).toBe("cloud_unreachable");
    expect(result.text).toContain("{{REDACTED_EMAIL}}");
    expect(events.find((e) => e.event === "snapshot.codec_unreachable")).toBeDefined();
  });

  it("410 session_expired → rotate session + degraded path", async () => {
    const cloud = new CloudClient({
      apiKey: "jdck_id.secret",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { code: "session_expired", message: "expired" } }),
          { status: 410, headers: { "content-type": "application/json" } },
        ),
      retries: 0,
      sleep: async () => {},
    });
    const session = new SessionState();
    const before = session.peek();
    const { events, logger } = makeLogger();
    const result = await handleSnapshot(RESPONSE, { cloud, session, bypass: false, log: logger });
    expect(result.outcome).toBe("cloud_unreachable");
    const after = session.peek();
    expect(after.sessionId).not.toBe(before.sessionId);
    expect(after.taskId).not.toBe(before.taskId);
    expect(events.find((e) => e.event === "snapshot.session_expired")).toBeDefined();
  });

  it("400 step_out_of_order → rotate task only + degraded path", async () => {
    const cloud = new CloudClient({
      apiKey: "jdck_id.secret",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { code: "step_out_of_order", message: "oops" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      retries: 0,
      sleep: async () => {},
    });
    const session = new SessionState();
    const before = session.peek();
    const result = await handleSnapshot(RESPONSE, { cloud, session, bypass: false });
    expect(result.outcome).toBe("cloud_unreachable");
    const after = session.peek();
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.taskId).not.toBe(before.taskId);
  });

  it("401 auth_invalid → degraded path with error log (not thrown)", async () => {
    const cloud = new CloudClient({
      apiKey: "jdck_id.secret",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { code: "auth_invalid", message: "bad key" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      retries: 0,
      sleep: async () => {},
    });
    const { events, logger } = makeLogger();
    const result = await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
      log: logger,
    });
    expect(result.outcome).toBe("cloud_unreachable");
    expect(result.text).toContain("{{REDACTED_EMAIL}}");
    expect(events.find((e) => e.event === "snapshot.cloud_terminal_error")).toBeDefined();
  });
});

describe("handleSnapshot — no YAML block", () => {
  it("passes upstream error responses through unchanged", async () => {
    const result = await handleSnapshot("Error: page closed", {
      cloud: null,
      session: new SessionState(),
      bypass: false,
    });
    expect(result.outcome).toBe("no_yaml");
    expect(result.text).toBe("Error: page closed");
  });
});

describe("handleSnapshot — telemetry draft", () => {
  it("populates telemetry draft with session_id, step, redaction_ms, cloud_ms on compressed outcome", async () => {
    const cloud = stubCloud(
      async () =>
        new Response(
          JSON.stringify({
            frame_type: "I",
            compressed_output: "X",
            compression_stats: { input_chars: 1, output_chars: 1, codec_ms: 1 },
          }),
          { status: 200 },
        ),
    );
    const session = new SessionState();
    const sessionPeek = session.peek();

    const result = await handleSnapshot(RESPONSE, {
      cloud,
      session,
      bypass: false,
    });

    expect(result.outcome).toBe("compressed");
    expect(result.telemetry).toBeDefined();
    const t = result.telemetry!;
    expect(t.session_id).toBe(sessionPeek.sessionId);
    expect(t.step).toBe(0);
    expect(typeof t.redaction_ms).toBe("number");
    expect(t.redaction_ms).toBeGreaterThanOrEqual(0);
    expect(typeof t.cloud_ms).toBe("number");
    expect(t.cloud_ms).toBeGreaterThanOrEqual(0);
  });

  it("populates telemetry draft on pass_through outcome", async () => {
    const cloud = stubCloud(
      async () =>
        new Response(
          JSON.stringify({
            frame_type: "pass-through",
            compression_stats: { input_chars: 1, output_chars: 1, codec_ms: 0 },
          }),
          { status: 200 },
        ),
    );
    const result = await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
    });
    expect(result.outcome).toBe("pass_through");
    expect(result.telemetry).toBeDefined();
  });

  it("does NOT populate telemetry on bypass outcome (no cloud round-trip)", async () => {
    const result = await handleSnapshot(RESPONSE, {
      cloud: null,
      session: new SessionState(),
      bypass: true,
    });
    expect(result.outcome).toBe("bypass");
    expect(result.telemetry).toBeUndefined();
  });

  it("does NOT populate telemetry on cloud_unreachable outcome", async () => {
    const cloud = stubCloud(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "server_error", message: "boom" } }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await handleSnapshot(RESPONSE, {
      cloud,
      session: new SessionState(),
      bypass: false,
    });
    expect(result.outcome).toBe("cloud_unreachable");
    expect(result.telemetry).toBeUndefined();
  });
});
