import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface UpstreamOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Thin wrapper around an upstream MCP server (Playwright MCP by default).
 * Spawns the subprocess via the SDK's StdioClientTransport, initialises a
 * client session, and exposes list/call.
 */
export class UpstreamSession {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: UpstreamTool[] = [];

  async start(opts: UpstreamOptions): Promise<UpstreamTool[]> {
    this.transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      env: opts.env,
    });
    this.client = new Client(
      { name: "jdcodec-connector", version: "0.1.0" },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
    const listed = await this.client.listTools();
    this.tools = (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema: t.inputSchema,
    }));
    return this.tools;
  }

  getTools(): UpstreamTool[] {
    return this.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    if (!this.client) throw new Error("upstream_not_started");
    const result = (await this.client.callTool({ name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const parts = (result.content ?? [])
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .filter(Boolean);
    return { text: parts.join("\n"), isError: Boolean(result.isError) };
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // best-effort shutdown
    }
    try {
      await this.transport?.close();
    } catch {
      // best-effort shutdown
    }
    this.client = null;
    this.transport = null;
  }
}
