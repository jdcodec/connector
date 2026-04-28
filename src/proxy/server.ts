import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CloudClient } from "../cloud/client.js";
import { SessionState } from "../session/state.js";
import type { UpstreamSession, UpstreamTool } from "./upstream.js";
import { handleSnapshot } from "./snapshot.js";
import type { Logger } from "./snapshot.js";

const SNAPSHOT_TOOL = "browser_snapshot";

export interface ProxyDeps {
  upstream: UpstreamSession;
  cloud: CloudClient | null;
  bypass: boolean;
  log: Logger;
}

export interface ProxyHandle {
  server: McpServer;
  close(): Promise<void>;
}

/**
 * Assemble the proxy McpServer. `browser_snapshot` is intercepted: response
 * text is handed to handleSnapshot() which runs Privacy Shield + cloud POST.
 * Everything else is passed through verbatim to upstream.
 */
export async function startProxy(deps: ProxyDeps): Promise<ProxyHandle> {
  const { upstream, cloud, bypass, log } = deps;
  const session = new SessionState();

  const server = new McpServer(
    { name: "jdcodec", version: "0.1.0" },
    {
      instructions:
        "JDCodec proxy for Playwright MCP. Provides compressed browser snapshots " +
        "for token efficiency; forwards all other tools transparently.",
    },
  );

  for (const tool of upstream.getTools()) {
    if (tool.name === SNAPSHOT_TOOL) {
      registerSnapshotTool(server, tool, { upstream, cloud, bypass, session, log });
    } else {
      registerPassthroughTool(server, tool, upstream, log);
    }
  }

  const transport = new StdioServerTransport();
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

interface SnapshotDeps {
  upstream: UpstreamSession;
  cloud: CloudClient | null;
  bypass: boolean;
  session: SessionState;
  log: Logger;
}

function registerSnapshotTool(
  server: McpServer,
  tool: UpstreamTool,
  deps: SnapshotDeps,
): void {
  const description =
    tool.description ??
    "Take a snapshot of the current page's accessibility tree (compressed by JDCodec).";

  server.registerTool(
    tool.name,
    {
      description,
      inputSchema: {},
    },
    async (_args, _extra) => {
      const upstreamResult = await deps.upstream.callTool(tool.name, {});
      if (upstreamResult.isError) {
        return {
          content: [{ type: "text", text: upstreamResult.text }],
          isError: true,
        };
      }
      try {
        const handled = await handleSnapshot(upstreamResult.text, {
          cloud: deps.cloud,
          session: deps.session,
          bypass: deps.bypass,
          log: deps.log,
        });
        return { content: [{ type: "text", text: handled.text }] };
      } catch (err) {
        deps.log.error("snapshot.unexpected_error", {
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
    },
  );
}

function registerPassthroughTool(
  server: McpServer,
  tool: UpstreamTool,
  upstream: UpstreamSession,
  log: Logger,
): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description ?? `Passthrough to upstream ${tool.name}`,
      inputSchema: {},
    },
    async (args, _extra) => {
      const result = await upstream.callTool(tool.name, (args ?? {}) as Record<string, unknown>);
      log.info("passthrough", { tool: tool.name, response_chars: result.text.length });
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    },
  );
}
