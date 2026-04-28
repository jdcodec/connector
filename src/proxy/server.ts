import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CloudClient } from "../cloud/client.js";
import { SessionState } from "../session/state.js";
import type { UpstreamSession } from "./upstream.js";
import { handleSnapshot } from "./snapshot.js";
import type { Logger } from "./snapshot.js";

const SNAPSHOT_TOOL = "browser_snapshot";

export interface ProxyDeps {
  upstream: UpstreamSession;
  cloud: CloudClient | null;
  bypass: boolean;
  log: Logger;
  // Optional transport injection for tests; production path uses stdio.
  transport?: Transport;
}

export interface ProxyHandle {
  server: Server;
  close(): Promise<void>;
}

/**
 * Assemble the proxy server. `browser_snapshot` is intercepted: response text
 * is handed to handleSnapshot() which runs Privacy Shield + cloud POST.
 * Everything else passes through verbatim — upstream's actual inputSchema is
 * preserved on tools/list so the agent knows what args to send, and arguments
 * are forwarded untouched on tools/call. Using the low-level Server (rather
 * than McpServer) is what lets us pass arbitrary args without forcing every
 * upstream JSON Schema through a Zod conversion.
 */
export async function startProxy(deps: ProxyDeps): Promise<ProxyHandle> {
  const { upstream, cloud, bypass, log } = deps;
  const session = new SessionState();

  const server = new Server(
    { name: "jdcodec", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "JDCodec proxy for Playwright MCP. Provides compressed browser snapshots " +
        "for token efficiency; forwards all other tools transparently.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: upstream.getTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema:
        (t.inputSchema as Record<string, unknown> | undefined) ?? {
          type: "object",
          properties: {},
        },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === SNAPSHOT_TOOL) {
      const upstreamResult = await upstream.callTool(name, args);
      if (upstreamResult.isError) {
        return {
          content: [{ type: "text", text: upstreamResult.text }],
          isError: true,
        };
      }
      try {
        const handled = await handleSnapshot(upstreamResult.text, {
          cloud,
          session,
          bypass,
          log,
        });
        return { content: [{ type: "text", text: handled.text }] };
      } catch (err) {
        log.error("snapshot.unexpected_error", {
          message: (err as Error)?.message ?? "unknown",
        });
        return {
          content: [
            {
              type: "text",
              text: "[JDCodec: snapshot handler failed; see connector logs]",
            },
          ],
          isError: true,
        };
      }
    }

    const result = await upstream.callTool(name, args);
    log.info("passthrough", { tool: name, response_chars: result.text.length });
    return {
      content: [{ type: "text", text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    };
  });

  const transport = deps.transport ?? new StdioServerTransport();
  await server.connect(transport);
  log.info("proxy.started", {
    tool_count: upstream.getTools().length,
    bypass,
    cloud_enabled: cloud !== null,
  });

  return {
    server,
    close: async () => {
      try {
        await server.close();
      } catch {
        // best-effort
      }
    },
  };
}
