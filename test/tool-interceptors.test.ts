import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  startProxy,
  DEFAULT_INTERCEPTORS,
  type ToolInterceptor,
} from "../src/proxy/server.js";
import type { UpstreamSession, UpstreamTool } from "../src/proxy/upstream.js";

// Regression-of-the-future test for the tool-interceptor registry
// (replacement for the `SNAPSHOT_TOOL = "browser_snapshot"` constant).
// Pins three guarantees that future adapters (browser-use, Stagehand,
// direct CDP) can rely on:
//
//   1. `DEFAULT_INTERCEPTORS` contains the production `browser_snapshot`
//      adapter and nothing else in M1.
//   2. A custom registry passed via `ProxyDeps.interceptors` overrides
//      the default — the synthetic tool name fires its handler, and
//      browser_snapshot falls through to passthrough when not present.
//   3. The interceptor receives both args and the upstream result, so an
//      adapter can branch on either.

const DUMMY_SCHEMA = {
  type: "object",
  properties: {
    payload: { type: "string", description: "Test payload" },
  },
};

function makeFakeUpstream(): UpstreamSession {
  const tools: UpstreamTool[] = [
    {
      name: "browser_snapshot",
      description: "Capture accessibility snapshot",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "fake_adapter_tool",
      description: "Synthetic tool for the registry test",
      inputSchema: DUMMY_SCHEMA,
    },
  ];
  return {
    getTools: () => tools,
    callTool: async (name, _args) => {
      if (name === "browser_snapshot") {
        return {
          text: "### Page\n- Page URL: about:blank\n### Snapshot\n```yaml\n```",
          isError: false,
        };
      }
      if (name === "fake_adapter_tool") {
        return { text: "raw upstream output", isError: false };
      }
      return { text: "ok", isError: false };
    },
    start: async () => tools,
    close: async () => undefined,
  } as unknown as UpstreamSession;
}

function makeLog() {
  const events: Array<{ level: string; event: string; ctx: unknown }> = [];
  return {
    log: {
      info: (event: string, ctx?: unknown) =>
        events.push({ level: "info", event, ctx }),
      warn: (event: string, ctx?: unknown) =>
        events.push({ level: "warn", event, ctx }),
      error: (event: string, ctx?: unknown) =>
        events.push({ level: "error", event, ctx }),
    },
    events,
  };
}

describe("tool-interceptor registry", () => {
  it("DEFAULT_INTERCEPTORS contains only browser_snapshot in M1", () => {
    expect([...DEFAULT_INTERCEPTORS.keys()]).toEqual(["browser_snapshot"]);
  });

  it("custom registry routes a synthetic tool name through its interceptor", async () => {
    const upstream = makeFakeUpstream();
    const { log } = makeLog();
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    let interceptorFired = false;
    let receivedArgs: Record<string, unknown> | null = null;
    let receivedUpstreamText: string | null = null;

    const fakeAdapter: ToolInterceptor = async (args, upstreamResult, _deps) => {
      interceptorFired = true;
      receivedArgs = args;
      receivedUpstreamText = upstreamResult.text;
      return {
        content: [
          {
            type: "text" as const,
            text: `[fake-adapter wrapped: ${upstreamResult.text}]`,
          },
        ],
      };
    };

    const handle = await startProxy({
      upstream,
      cloud: null,
      bypass: true,
      log,
      transport: serverTransport,
      interceptors: new Map([["fake_adapter_tool", fakeAdapter]]),
    });

    const client = new Client(
      { name: "registry-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "fake_adapter_tool",
        arguments: { payload: "hello" },
      });

      expect(interceptorFired).toBe(true);
      expect(receivedArgs).toEqual({ payload: "hello" });
      expect(receivedUpstreamText).toBe("raw upstream output");

      const content = (result as {
        content: Array<{ type: string; text: string }>;
      }).content;
      expect(content[0].text).toBe(
        "[fake-adapter wrapped: raw upstream output]",
      );
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it("degraded mode: cloud=null + bypass=false returns auth_required for browser_snapshot", async () => {
    // The connector starts even without an API key (degraded mode).
    // Calls to interceptor-backed tools (today: browser_snapshot only)
    // fail fast with an actionable error rather than firing a wasted
    // upstream call that we couldn't compress anyway.
    const upstream = makeFakeUpstream();
    const { log, events } = makeLog();
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    let upstreamFired = false;
    const guardedUpstream = {
      ...upstream,
      callTool: async (name: string, args: Record<string, unknown>) => {
        upstreamFired = true;
        return upstream.callTool(name, args);
      },
    } as unknown as UpstreamSession;

    const handle = await startProxy({
      upstream: guardedUpstream,
      cloud: null,
      bypass: false,
      log,
      transport: serverTransport,
    });

    const client = new Client(
      { name: "auth-gate-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const result = (await client.callTool({
        name: "browser_snapshot",
        arguments: {},
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("API key required");
      expect(result.content[0].text).toContain("jdcodec start");
      expect(result.content[0].text).toContain("~/.jdcodec/config.json");

      // Crucially: no upstream call was made — we don't waste a real
      // browser snapshot on a request we can't fulfil.
      expect(upstreamFired).toBe(false);

      // And the auth-missing event is logged so operators can see the
      // pattern in stderr / log aggregators.
      const authEvent = events.find((e) => e.event === "auth.missing_for_tool");
      expect(authEvent).toBeDefined();
      expect((authEvent!.ctx as { tool?: string }).tool).toBe("browser_snapshot");
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it("degraded-mode gate does NOT fire when bypass=true (cloud=null is intentional)", async () => {
    // JDC_BYPASS=1 explicitly opts into cloud=null with no compression.
    // The auth gate must not fire for bypass users — they get the existing
    // redacted-passthrough path. This regression test pins the distinction.
    const upstream = makeFakeUpstream();
    const { log, events } = makeLog();
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    const handle = await startProxy({
      upstream,
      cloud: null,
      bypass: true,
      log,
      transport: serverTransport,
    });

    const client = new Client(
      { name: "bypass-still-works-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const result = (await client.callTool({
        name: "browser_snapshot",
        arguments: {},
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };

      // No auth-required error in bypass mode.
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).not.toContain("API key required");

      // No auth-missing log event either.
      expect(events.some((e) => e.event === "auth.missing_for_tool")).toBe(false);
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it("degraded-mode gate does NOT fire for non-interceptor tools (e.g. browser_navigate)", async () => {
    // browser_navigate / browser_click and other passthrough tools don't
    // hit the cloud — they should still work with no key configured.
    // The connector becomes a transparent Playwright proxy in that mode.
    const upstream = makeFakeUpstream();
    const { log } = makeLog();
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    const handle = await startProxy({
      upstream,
      cloud: null,
      bypass: false,
      log,
      transport: serverTransport,
    });

    const client = new Client(
      { name: "passthrough-no-key-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const result = (await client.callTool({
        name: "fake_adapter_tool",
        arguments: { payload: "navigate" },
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe("raw upstream output");
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it("custom registry without browser_snapshot lets it fall through to passthrough", async () => {
    // When a test (or future adapter override) doesn't include
    // browser_snapshot in its registry, the call should land on the
    // passthrough path — not silently no-op.
    const upstream = makeFakeUpstream();
    const { log, events } = makeLog();
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    const handle = await startProxy({
      upstream,
      cloud: null,
      bypass: true,
      log,
      transport: serverTransport,
      // Empty registry — nothing intercepted; everything passes through.
      interceptors: new Map(),
    });

    const client = new Client(
      { name: "registry-empty-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      await client.callTool({ name: "browser_snapshot", arguments: {} });
      // Confirm the snapshot-handler path did NOT fire (no snapshot.bypass log).
      expect(events.some((e) => e.event === "snapshot.bypass")).toBe(false);
      // And the passthrough log fired for it instead.
      const passthrough = events.find(
        (e) =>
          e.event === "passthrough" &&
          (e.ctx as { tool?: string })?.tool === "browser_snapshot",
      );
      expect(passthrough).toBeDefined();
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

describe("tool-interceptor — telemetry POST after successful snapshot", () => {
  it("fires postTelemetry exactly once with the four measured fields", async () => {
    const upstream = makeFakeUpstream();
    const { log, events } = makeLog();
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    // Custom interceptor that returns a telemetry draft (mimicking what
    // the real browser_snapshot interceptor does after a successful
    // cloud round-trip). Bypasses needing a real CloudClient mock for
    // the snapshot path while still exercising the proxy's telemetry
    // dispatch logic.
    const draft = {
      session_id: "9c1b2f6e-0b8e-4a77-9cfd-3e3f7b5e8d21",
      step: 0,
      redaction_ms: 0.5,
      cloud_ms: 12.3,
    };
    const fakeAdapter: ToolInterceptor = async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      telemetry: draft,
    });

    const telemetryPosts: Array<Record<string, unknown>> = [];
    const cloud = {
      postTelemetry: async (body: Record<string, unknown>) => {
        telemetryPosts.push(body);
        return { requestId: "rid", httpStatus: 204 };
      },
    } as unknown as import("../src/cloud/client.js").CloudClient;

    const handle = await startProxy({
      upstream,
      cloud,
      bypass: false,
      log,
      transport: serverTransport,
      interceptors: new Map([["fake_adapter_tool", fakeAdapter]]),
    });

    const client = new Client(
      { name: "telemetry-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "fake_adapter_tool",
        arguments: {},
      });

      // The MCP SDK return surface must NOT include the telemetry field.
      expect(result).not.toHaveProperty("telemetry");

      // Allow the fire-and-forget telemetry POST to flush.
      await new Promise((r) => setTimeout(r, 10));

      expect(telemetryPosts).toHaveLength(1);
      const posted = telemetryPosts[0];
      expect(posted.session_id).toBe(draft.session_id);
      expect(posted.step).toBe(draft.step);
      expect(posted.redaction_ms).toBe(draft.redaction_ms);
      expect(posted.cloud_ms).toBe(draft.cloud_ms);
      expect(typeof posted.upstream_ms).toBe("number");
      expect(posted.upstream_ms).toBeGreaterThanOrEqual(0);
      expect(typeof posted.client_round_trip_ms).toBe("number");
      expect(posted.client_round_trip_ms).toBeGreaterThanOrEqual(
        posted.upstream_ms as number,
      );
      expect(posted.connector_version).toMatch(/^jdcodec@/);
    } finally {
      await client.close();
      await handle.close();
      void events;
    }
  });

  it("does NOT fire telemetry when the interceptor returns no telemetry draft (bypass / unreachable)", async () => {
    const upstream = makeFakeUpstream();
    const { log } = makeLog();
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    const fakeAdapter: ToolInterceptor = async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      // no telemetry field
    });

    const telemetryPosts: unknown[] = [];
    const cloud = {
      postTelemetry: async () => {
        telemetryPosts.push(true);
        return { requestId: "rid", httpStatus: 204 };
      },
    } as unknown as import("../src/cloud/client.js").CloudClient;

    const handle = await startProxy({
      upstream,
      cloud,
      bypass: false,
      log,
      transport: serverTransport,
      interceptors: new Map([["fake_adapter_tool", fakeAdapter]]),
    });

    const client = new Client(
      { name: "telemetry-skip-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      await client.callTool({
        name: "fake_adapter_tool",
        arguments: {},
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(telemetryPosts).toHaveLength(0);
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it("a postTelemetry rejection is logged but does not surface to the agent", async () => {
    const upstream = makeFakeUpstream();
    const { log, events } = makeLog();
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    const fakeAdapter: ToolInterceptor = async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      telemetry: {
        session_id: "9c1b2f6e-0b8e-4a77-9cfd-3e3f7b5e8d21",
        step: 0,
        redaction_ms: 0,
        cloud_ms: 0,
      },
    });

    const cloud = {
      postTelemetry: async () => {
        throw new Error("simulated network blip");
      },
    } as unknown as import("../src/cloud/client.js").CloudClient;

    const handle = await startProxy({
      upstream,
      cloud,
      bypass: false,
      log,
      transport: serverTransport,
      interceptors: new Map([["fake_adapter_tool", fakeAdapter]]),
    });

    const client = new Client(
      { name: "telemetry-fail-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "fake_adapter_tool",
        arguments: {},
      });
      const content = (result.content as Array<{ text: string }>)[0];
      expect(content.text).toBe("ok"); // call succeeded from the agent's POV
      await new Promise((r) => setTimeout(r, 10));

      const failedLog = events.find(
        (e) => e.event === "telemetry.post_failed",
      );
      expect(failedLog).toBeDefined();
      expect(failedLog!.level).toBe("warn");
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
