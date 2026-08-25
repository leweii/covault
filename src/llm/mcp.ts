/**
 * MCP client side of Ask: the user lists servers in settings (same JSON
 * shape as Claude Desktop's mcpServers block), and every tool those
 * servers expose joins the agent's tool surface, namespaced by server.
 *
 * Configuring a server is the standing consent to run it; individual
 * tool calls still go through the approval gate the first time each
 * tool is used in a conversation (needsApproval), so nothing fires
 * silently.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TSchema } from "typebox";
import type { AskTool } from "./agentTools";

export interface McpServerConfig {
  name: string;
  /** stdio transport: a command to spawn… */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** …or HTTP transport: a URL to connect to. */
  url?: string;
}

/**
 * Accepts Claude-Desktop-style `{"mcpServers": {"name": {...}}}` or a
 * plain array of {name, ...}. Throws with a readable message on bad JSON.
 */
export function parseMcpConfig(json: string): McpServerConfig[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`MCP config is not valid JSON: ${(e as Error).message}`);
  }
  const obj = raw as Record<string, unknown>;
  const entries: McpServerConfig[] = [];
  const table = (obj.mcpServers ?? (Array.isArray(raw) ? null : raw)) as Record<string, unknown> | null;
  if (Array.isArray(raw)) {
    for (const item of raw as Record<string, unknown>[]) {
      if (typeof item?.name === "string") entries.push(item as unknown as McpServerConfig);
    }
  } else if (table && typeof table === "object") {
    for (const [name, cfg] of Object.entries(table)) {
      if (cfg && typeof cfg === "object") entries.push({ name, ...(cfg as object) } as McpServerConfig);
    }
  }
  return entries.filter((s) => s.command || s.url);
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

interface McpText {
  type: string;
  text?: string;
}

export class McpManager {
  private clients = new Map<string, Client>();

  constructor(private getConfigJson: () => string) {}

  private async connect(server: McpServerConfig): Promise<Client> {
    const existing = this.clients.get(server.name);
    if (existing) return existing;
    const client = new Client({ name: "covault", version: "1.0.0" });
    if (server.command) {
      await client.connect(
        new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
          stderr: "ignore",
        }),
      );
    } else if (server.url) {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    } else {
      throw new Error(`MCP server "${server.name}" has neither a command nor a url.`);
    }
    this.clients.set(server.name, client);
    return client;
  }

  /** Connect every configured server and collect its tools. A server
   *  that fails to connect is skipped with a warning — one broken entry
   *  must not take Ask down. */
  async tools(): Promise<AskTool[]> {
    const servers = parseMcpConfig(this.getConfigJson());
    const out: AskTool[] = [];
    for (const server of servers) {
      try {
        const client = await this.connect(server);
        const listed = await client.listTools();
        for (const tool of listed.tools) {
          const fullName = `${sanitize(server.name)}__${sanitize(tool.name)}`;
          out.push({
            name: fullName,
            description: `[${server.name}] ${tool.description ?? tool.name}`,
            parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as unknown as TSchema,
            statusFor: () => `${server.name}: ${tool.name}…`,
            needsApproval: () => `${server.name}: ${tool.name}`,
            execute: async (args) => {
              const result = await client.callTool({ name: tool.name, arguments: args });
              const content = (result.content ?? []) as McpText[];
              const text = content
                .filter((c) => c.type === "text" && typeof c.text === "string")
                .map((c) => c.text)
                .join("\n");
              return { text: text || "(no text content)", isError: result.isError === true };
            },
          });
        }
      } catch (e) {
        console.warn(`[covault] MCP server "${server.name}" unavailable:`, e);
      }
    }
    return out;
  }

  async dispose(): Promise<void> {
    for (const [, client] of this.clients) {
      try {
        await client.close();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }
}
