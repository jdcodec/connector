import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startProxy } from "../src/proxy/server.js";
import type { UpstreamSession, UpstreamTool } from "../src/proxy/upstream.js";

// Regression test for BUG-001: every passthrough tool used to be registered
// with `inputSchema: {}` via `McpServer.registerTool`, which caused the SDK to
// strip every property of `tools/call.arguments` before invoking the handler.
// `browser_navigate {url: "https://example.com"}` arrived at upstream as `{}`,
// failing Playwright MCP's Zod check. This file pins three guarantees:
//
//   1. tools/list advertises the upstream's actual inputSchema (not empty).
//   2. tools/call forwards arguments untouched.
//   3. browser_snapshot still routes through the snapshot handler (cloud
//      disabled here; we only assert the upstream call shape, not compression).

const NAVIGATE_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "Target URL" },
  },
  required: ["url"],
};

const SNAPSHOT_SCHEMA = {
  type: "object",
  properties: {},
};

interface CallRecord {
  name: string;
  args: Record<string, unknown>;
}

function makeFakeUpstream(): UpstreamSession & { calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const tools: UpstreamTool[] = [
    {
      name: "browser_navigate",
      description: "Navigate to a URL",
      inputSchema: NAVIGATE_SCHEMA,
    },
    {
      name: "browser_snapshot",
      description: "Capture accessibility snapshot",
      inputSchema: SNAPSHOT_SCHEMA,
    },
  ];
  // Construct a minimal UpstreamSession-shaped object; the proxy server only
  // touches getTools / callTool / close.
  return {
    calls,
    getTools: () => tools,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "browser_navigate") {
        if (typeof args.url !== "string") {
          return {
            text: `### Error\n[{"path":["url"],"message":"expected string"}]`,
            isError: true,
          };
        }
        return { text: `navigated to ${args.url as string}`, isError: false };
      }
      if (name === "browser_snapshot") {
        return { text: "### Page\n- Page URL: about:blank\n### Snapshot\n```yaml\n```", isError: false };
      }
      return { text: "ok", isError: false };
    },
    start: async () => tools,
    close: async () => undefined,
  } as unknown as UpstreamSession & { calls: CallRecord[] };
}

function makeLog() {
  const events: Array<{ level: string; event: string; ctx: unknown }> = [];
  return {
    log: {
      info: (event: string, ctx?: unknown) => events.push({ level: "info", event, ctx }),
      warn: (event: string, ctx?: unknown) => events.push({ level: "warn", event, ctx }),
      error: (event: string, ctx?: unknown) => events.push({ level: "error", event, ctx }),
    },
    events,
  };
}

async function wireProxyAndClient(): Promise<{
  client: Client;
  upstream: ReturnType<typeof makeFakeUpstream>;
  events: Array<{ level: string; event: string; ctx: unknown }>;
  shutdown: () => Promise<void>;
}> {
  const upstream = makeFakeUpstream();
  const { log, events } = makeLog();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  const handle = await startProxy({
    upstream,
    cloud: null,
    bypass: true,
    log,
    transport: serverTransport,
  });

  const client = new Client(
    { name: "passthrough-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    client,
    upstream,
    events,
    shutdown: async () => {
      await client.close();
      await handle.close();
    },
  };
}

describe("proxy passthrough — BUG-001 regression", () => {
  it("tools/list advertises the upstream's real inputSchema (not empty)", async () => {
    const { client, shutdown } = await wireProxyAndClient();
    try {
      const list = await client.listTools();
      const navTool = list.tools.find((t) => t.name === "browser_navigate");
      expect(navTool).toBeDefined();
      expect(navTool!.inputSchema).toMatchObject({
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      });
    } finally {
      await shutdown();
    }
  });

  it("tools/call forwards arguments untouched to upstream", async () => {
    const { client, upstream, shutdown } = await wireProxyAndClient();
    try {
      const result = await client.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.com/path?q=1" },
      });

      // Upstream must have received the URL, not an empty object.
      expect(upstream.calls).toEqual([
        { name: "browser_navigate", args: { url: "https://example.com/path?q=1" } },
      ]);

      // Result is forwarded verbatim from the fake upstream.
      const content = (result as { content: Array<{ type: string; text: string }> }).content;
      expect(content[0].text).toBe("navigated to https://example.com/path?q=1");
      expect((result as { isError?: boolean }).isError).toBeFalsy();
    } finally {
      await shutdown();
    }
  });

  it("browser_snapshot still routes through the snapshot path under bypass", async () => {
    const { client, upstream, events, shutdown } = await wireProxyAndClient();
    try {
      await client.callTool({ name: "browser_snapshot", arguments: {} });
      // Upstream was called for the snapshot.
      expect(upstream.calls.find((c) => c.name === "browser_snapshot")).toBeDefined();
      // Snapshot path emitted a snapshot.bypass log (cloud null + bypass true).
      expect(events.some((e) => e.event === "snapshot.bypass")).toBe(true);
      // No passthrough log for the snapshot tool.
      expect(events.some((e) => e.event === "passthrough" && (e.ctx as { tool?: string })?.tool === "browser_snapshot")).toBe(false);
    } finally {
      await shutdown();
    }
  });
});
