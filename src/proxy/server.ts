import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CloudClient } from "../cloud/client.js";
import { SessionState } from "../session/state.js";
import { VERSION } from "../onboarding/version.js";
import type { UpstreamSession } from "./upstream.js";
import { handleSnapshot } from "./snapshot.js";
import type { Logger, SnapshotTelemetryDraft, TraceConfig } from "./snapshot.js";

/**
 * Context handed to every interceptor. Mirrors the slice of `ProxyDeps` that
 * an interceptor actually needs — keeps the per-tool implementation honest
 * about its dependencies.
 */
export interface InterceptDeps {
  upstream: UpstreamSession;
  cloud: CloudClient | null;
  session: SessionState;
  bypass: boolean;
  log: Logger;
  trace?: TraceConfig;
}

/** Result shape mirrors the MCP SDK `CallToolResult`, plus an optional
 * telemetry draft the request handler uses to fire a /v1/telemetry POST
 * after the call returns. The telemetry field is stripped from the
 * surface the MCP SDK sees. */
export interface ToolInterceptResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  telemetry?: SnapshotTelemetryDraft;
}

function nsNow(): bigint {
  return process.hrtime.bigint();
}

function msSince(start: bigint): number {
  return Number(nsNow() - start) / 1e6;
}

/**
 * Tool-name interceptor. Receives the upstream call's already-fetched
 * result so the interceptor doesn't decide *whether* to call upstream —
 * that's the registry's job. The interceptor decides what to do with the
 * response (e.g. run Privacy Shield + cloud POST for `browser_snapshot`).
 */
export type ToolInterceptor = (
  args: Record<string, unknown>,
  upstreamResult: { text: string; isError?: boolean },
  deps: InterceptDeps,
) => Promise<ToolInterceptResult>;

/**
 * `browser_snapshot` adapter — the only interceptor in M1. Drives Privacy
 * Shield + the cloud codec POST via `handleSnapshot()`. Forwards upstream
 * errors verbatim so a Playwright failure surfaces to the agent.
 */
async function browserSnapshotInterceptor(
  _args: Record<string, unknown>,
  upstreamResult: { text: string; isError?: boolean },
  deps: InterceptDeps,
): Promise<ToolInterceptResult> {
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
      ...(deps.trace ? { trace: deps.trace } : {}),
    });
    return {
      content: [{ type: "text", text: handled.text }],
      ...(handled.telemetry ? { telemetry: handled.telemetry } : {}),
    };
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
}

/**
 * Default tool-interceptor registry. One entry today; the registry shape
 * exists so future framework adapters (browser-use, Stagehand, direct CDP)
 * can add interceptors without editing the request handler.
 *
 * Production code reads from this default. Tests inject their own registry
 * via `ProxyDeps.interceptors` to verify the dispatch path with synthetic
 * tool names.
 */
export const DEFAULT_INTERCEPTORS: ReadonlyMap<string, ToolInterceptor> =
  new Map<string, ToolInterceptor>([
    ["browser_snapshot", browserSnapshotInterceptor],
  ]);

/**
 * Returned by the call-time auth gate when a tool that needs the cloud
 * codec is invoked without a key configured. Plain English so the agent
 * can relay it directly to the user; structured `isError: true` so MCP
 * clients render it as an error rather than an answer.
 */
function authRequiredResponse(toolName: string): ToolInterceptResult {
  const text = [
    `JDCodec: API key required for ${toolName}.`,
    "",
    "Get a key:",
    "  1. Run: jdcodec start",
    "  2. Wait for your key by email (~24h during early access).",
    "  3. Save it to ~/.jdcodec/config.json:",
    `       { "api_key": "jdck_yourid.yoursecret" }`,
    "  4. Restart your AI client so the connector picks up the key.",
    "",
    "Run `jdcodec doctor` for a full diagnostic.",
  ].join("\n");
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

export interface ProxyDeps {
  upstream: UpstreamSession;
  cloud: CloudClient | null;
  bypass: boolean;
  log: Logger;
  /** When set, snapshot interceptor writes per-match span JSONL. JDC_TRACE=1 only. */
  trace?: TraceConfig;
  // Optional transport injection for tests; production path uses stdio.
  transport?: Transport;
  /**
   * Optional interceptor registry override. Defaults to
   * `DEFAULT_INTERCEPTORS` (which today contains only `browser_snapshot`).
   * Tests pass synthetic registries to exercise the dispatch path.
   */
  interceptors?: ReadonlyMap<string, ToolInterceptor>;
}

export interface ProxyHandle {
  server: Server;
  close(): Promise<void>;
}

/**
 * Assemble the proxy server. Tools listed in the interceptor registry
 * (default: `browser_snapshot` → `handleSnapshot`) get their upstream
 * response handed to the matching interceptor — typically Privacy Shield
 * + the cloud codec POST. Everything else passes through verbatim:
 * upstream's actual `inputSchema` is preserved on `tools/list` so the
 * agent knows what args to send, and arguments are forwarded untouched
 * on `tools/call`. Using the low-level `Server` (rather than `McpServer`)
 * is what lets us pass arbitrary args without forcing every upstream JSON
 * Schema through a Zod conversion — that conversion would silently strip
 * passthrough tool arguments.
 */
export async function startProxy(deps: ProxyDeps): Promise<ProxyHandle> {
  const { upstream, cloud, bypass, log } = deps;
  const interceptors = deps.interceptors ?? DEFAULT_INTERCEPTORS;
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

    const interceptor = interceptors.get(name);

    // Call-time auth gate. Tools registered as interceptors today only
    // exist to wrap the cloud-codec round-trip (browser_snapshot). With
    // no API key and no bypass, there's nothing useful we can do for
    // them — fail fast with an actionable error instead of firing the
    // upstream call (which would, for browser_snapshot, take an actual
    // browser snapshot we can't compress).
    if (interceptor && cloud === null && !bypass) {
      log.warn("auth.missing_for_tool", { tool: name });
      return authRequiredResponse(name) as unknown as {
        content: Array<{ type: "text"; text: string }>;
        isError?: boolean;
      };
    }

    if (interceptor) {
      // Customer-experienced wall-clock for this tool call. Timed at the
      // outermost boundary the connector controls; covers the upstream
      // call + Privacy Shield + cloud round-trip + any framework cost.
      const tRoundTrip = nsNow();
      const tUpstream = nsNow();
      const upstreamResult = await upstream.callTool(name, args);
      const upstreamMs = msSince(tUpstream);
      const intercepted = await interceptor(args, upstreamResult, {
        upstream,
        cloud,
        session,
        bypass,
        log,
        ...(deps.trace ? { trace: deps.trace } : {}),
      });
      // Fire-and-forget telemetry POST. Only present on outcomes where
      // the cloud round-trip succeeded — bypass/no-yaml/cloud-unreachable
      // skip telemetry since there's no usage_events row to join against.
      // Failures are logged and never surfaced to the agent (telemetry is
      // observability-only, never billable, never load-bearing).
      if (intercepted.telemetry && cloud) {
        const draft = intercepted.telemetry;
        const clientRoundTripMs = msSince(tRoundTrip);
        cloud
          .postTelemetry({
            session_id: draft.session_id,
            step: draft.step,
            client_round_trip_ms: clientRoundTripMs,
            redaction_ms: draft.redaction_ms,
            cloud_ms: draft.cloud_ms,
            upstream_ms: upstreamMs,
            connector_version: `jdcodec@${VERSION}`,
          })
          .catch((err: unknown) => {
            log.warn("telemetry.post_failed", {
              session_id: draft.session_id,
              step: draft.step,
              cause: (err as Error)?.message ?? "unknown",
            });
          });
      }
      // Strip the telemetry field before returning to the SDK — it isn't
      // part of the MCP CallToolResult contract. The MCP SDK's
      // `setRequestHandler` return type also unions a task-shape variant
      // onto the basic `CallToolResult`; cast through unknown so the
      // interceptor contract stays clean while satisfying the SDK's
      // signature.
      const { telemetry: _telemetry, ...rest } = intercepted;
      void _telemetry;
      return rest as unknown as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
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
    interceptor_count: interceptors.size,
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
