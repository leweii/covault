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
import * as fs from "fs";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { TSchema } from "typebox";
import type { AskTool } from "./agentTools";
import { describeError } from "./transport";
import { LoopbackAuthReceiver, McpAuthStore, McpOAuthProvider, serverForState } from "./mcpOAuth";

export interface McpServerConfig {
  name: string;
  /** stdio transport: a command to spawn… */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** …or HTTP transport: a URL to connect to. */
  url?: string;
}

/** Last known outcome per configured server, for the settings page and
 *  for telling the user why Ask has no tools from it. */
export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http";
  ok: boolean;
  toolCount: number;
  /** User-facing reason when ok is false. */
  error?: string;
  /** Waiting for the user to sign in — an action, not a fault. Asking a
   *  question never triggers it; only an explicit click does. */
  needsAuth?: boolean;
}

/** Thrown instead of opening a browser when a connect must stay silent. */
export class SignInRequired extends Error {
  constructor(public serverName: string) {
    super(`${serverName} needs you to sign in.`);
  }
}

/**
 * Turn a connection failure into something a user can act on. The raw
 * errors here are unhelpful ("fetch failed", "spawn npx ENOENT") and
 * their two overwhelmingly common causes both have a concrete fix.
 */
export function explainMcpError(error: unknown, server: McpServerConfig): string {
  // The cause chain, not just the top message: "fetch failed" carries its
  // diagnosis (ENOTFOUND, ECONNREFUSED…) one level down, and the regexes
  // below can only match what they can see.
  const raw = describeError(error);
  if (/\b401\b|unauthorized|invalid_token/i.test(raw)) {
    return "needs sign-in — a browser window should have opened; finish there, then ask again.";
  }
  if (/ENOENT|not found/i.test(raw) && server.command) {
    return (
      `couldn't start "${server.command}" — it isn't on the PATH Obsidian sees, even with your login ` +
      `shell's PATH loaded. Put an absolute path in "command" (\`which ${server.command}\`).`
    );
  }
  // A cold `uvx`/`npx` first downloads the package, which can outlast any
  // startup timeout — worth saying, because a retry usually just works.
  if (/timed out|ETIMEDOUT/i.test(raw) && server.command) {
    return (
      `"${server.command}" didn't finish starting in time. A first run downloads the package — run ` +
      `\`${[server.command, ...(server.args ?? [])].join(" ")}\` once in a terminal to cache it, then Check again.`
    );
  }
  return raw;
}

/** Extensions that make a bare name executable on Windows. */
function windowsExtensions(env: Record<string, string | undefined>): string[] {
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
}

/**
 * Absolute path for a bare command name, searching the PATH we were
 * handed. Resolving before spawning is what makes `"command": "uvx"`
 * behave in Obsidian the way it does in a terminal: on Windows spawn
 * ignores the child env's PATH entirely, and everywhere else the PATH in
 * question is one we reconstructed ourselves, so doing the lookup here
 * also lets the failure name what was searched.
 *
 * Returns null when nothing matches; the caller spawns the bare name and
 * lets the ENOENT explain itself.
 */
export function resolveCommandPath(
  command: string,
  env: Record<string, string | undefined>,
  platform: string = process.platform,
  isExecutable: (file: string) => boolean = defaultIsExecutable,
): string | null {
  // An explicit path — absolute or relative — is the user's own choice.
  if (command.includes("/") || command.includes("\\")) return null;
  const names =
    platform === "win32" && !path.extname(command)
      ? windowsExtensions(env).map((ext) => command + ext)
      : [command];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir.trim()) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function defaultIsExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
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

/** Startup budget for a stdio server, generous enough for a first-run
 *  package download. */
const STDIO_STARTUP_TIMEOUT_MS = 180_000;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

interface McpText {
  type: string;
  text?: string;
}

export class McpManager {
  private clients = new Map<string, Client>();
  private statuses = new Map<string, McpServerStatus>();
  /** Transports mid-OAuth: finishAuth must run on the same instance,
   *  which holds the discovered resource metadata and scope. */
  private awaitingAuth = new Map<string, StreamableHTTPClientTransport>();
  private receiver = new LoopbackAuthReceiver();
  readonly auth = new McpAuthStore();

  /** `env` supplies the user's real login-shell environment (see
   *  cliInventory): a GUI-launched Obsidian has a bare PATH, so without it
   *  a plain `"command": "npx"` fails with ENOENT. It may be async — the
   *  probe that finds that PATH has to be allowed to finish before the
   *  first spawn, or the fallback bare PATH is what gets used.
   *  `openBrowser` is how an OAuth server gets in front of the user. */
  constructor(
    private getConfigJson: () => string,
    private env?: () => Record<string, string | undefined> | Promise<Record<string, string | undefined>>,
    private openBrowser: (url: string) => void = (url) => window.open(url, "_blank"),
    /** Where a stdio server's own stderr goes. Discarding it is what made
     *  a slow start indistinguishable from a hang: the only thing that
     *  said "Downloading google-api-python-client (15.3MiB)" was the
     *  child's stderr. */
    private onLog: (line: string) => void = () => {},
  ) {}

  /** Stop waiting on a sign-in nobody is going to finish. */
  cancelAuth(): void {
    this.receiver.close();
  }

  /**
   * Sign in to one server, browser and all. The only path that may open a
   * browser — everywhere else connects silently, so a question is never
   * interrupted by an authorization page.
   */
  async signIn(serverName: string): Promise<void> {
    const server = parseMcpConfig(this.getConfigJson()).find((s) => s.name === serverName);
    if (!server) throw new Error(`"${serverName}" isn't in the connected-services config.`);
    // A half-connected client from an earlier silent attempt would be
    // returned as-is and skip the sign-in entirely.
    await this.close(serverName);
    const transport = server.command ? "stdio" : "http";
    try {
      const client = await this.connect(server, true);
      const listed = await client.listTools();
      this.statuses.set(server.name, { name: server.name, transport, ok: true, toolCount: listed.tools.length });
    } catch (e) {
      const needsAuth = e instanceof SignInRequired;
      this.statuses.set(server.name, {
        name: server.name,
        transport,
        ok: false,
        toolCount: 0,
        error: needsAuth ? "not signed in" : explainMcpError(e, server),
        needsAuth,
      });
      throw e;
    }
  }

  /** Forget one server's connection (not its tokens). */
  private async close(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    this.clients.delete(serverName);
    this.statuses.delete(serverName);
    try {
      await client?.close();
    } catch {
      /* already gone */
    }
  }

  /** What happened the last time each configured server was contacted. */
  status(): McpServerStatus[] {
    return parseMcpConfig(this.getConfigJson()).map(
      (s) =>
        this.statuses.get(s.name) ?? {
          name: s.name,
          transport: s.command ? "stdio" : "http",
          ok: false,
          toolCount: 0,
          error: "not contacted yet",
        },
    );
  }

  /** Servers the user could sign in to right now. */
  needingSignIn(): McpServerStatus[] {
    return this.status().filter((s) => s.needsAuth);
  }

  /** Servers that are broken for some other reason than sign-in. */
  broken(): McpServerStatus[] {
    return this.status().filter((s) => !s.ok && !s.needsAuth && s.error !== "not contacted yet");
  }

  /** Drop cached connections so the next tools() reconnects (config changed). */
  reset(): void {
    void this.dispose();
    this.statuses.clear();
  }

  /**
   * Connect a remote server, running the OAuth dance if it asks for one.
   *
   * The SDK does the protocol work; the sequencing is ours. On 401 it
   * calls the provider's redirectToAuthorization and then rejects the
   * connect with UnauthorizedError — so the browser has to be started
   * without waiting (we only capture the promise), and the code can only
   * be exchanged afterwards, once the rejection has handed us the
   * transport that finishAuth needs. Tokens saved, a fresh transport picks
   * them up: the SDK does not retry a connect it already failed.
   */
  private async connectHttp(server: McpServerConfig, client: Client, interactive: boolean): Promise<Client> {
    let pending: Promise<Record<string, string>> | null = null;
    const provider = new McpOAuthProvider(server.name, this.auth, async (url) => {
      // Asking a question must never hijack the screen with a browser, so
      // a non-interactive connect refuses here instead. Saved tokens (and
      // their refresh) still work — this only blocks the first sign-in.
      if (!interactive) throw new SignInRequired(server.name);
      // Bind before opening the browser: the redirect can come back fast,
      // and a port that isn't listening yet loses the code.
      await this.receiver.start();
      pending = this.receiver.result;
      this.openBrowser(url);
    });

    const url = new URL(server.url as string);
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    try {
      await client.connect(transport);
      return client;
    } catch (e) {
      if (e instanceof SignInRequired) throw e;
      if (!(e instanceof UnauthorizedError) || !pending) throw e;
      this.awaitingAuth.set(server.name, transport);
      try {
        await this.finishBrowserAuth(server.name, transport, pending);
      } finally {
        this.awaitingAuth.delete(server.name);
        this.receiver.close();
      }
      const authed = new Client({ name: "covault", version: "1.0.0" });
      await authed.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
      return authed;
    }
  }

  /** Verify the redirect and trade the code for tokens. */
  private async finishBrowserAuth(
    serverName: string,
    transport: StreamableHTTPClientTransport,
    pending: Promise<Record<string, string>>,
  ): Promise<void> {
    const params = await pending;
    if (params.error) throw new Error(`${serverName} refused the sign-in: ${params.error}`);
    // The SDK never checks `state`; an unverified code is a CSRF hole.
    if (serverForState(this.auth, params.state) !== serverName) {
      throw new Error("That sign-in didn't match the request that started it — start it again.");
    }
    if (!params.code) throw new Error(`${serverName} sent no authorization code.`);
    await transport.finishAuth(params.code);
  }

  private async connect(server: McpServerConfig, interactive: boolean): Promise<Client> {
    const existing = this.clients.get(server.name);
    if (existing) return existing;
    const client = new Client({ name: "covault", version: "1.0.0" });
    if (server.command) {
      const env = { ...((await this.env?.()) ?? process.env), ...(server.env ?? {}) } as Record<string, string>;
      const transport = new StdioClientTransport({
        command: resolveCommandPath(server.command, env) ?? server.command,
        args: server.args ?? [],
        env,
        // "pipe", not "ignore": read below, never inherited — a child
        // writing to Obsidian's own stderr goes nowhere a user can see.
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim()) this.onLog(`${server.name}: ${line.trim()}`);
        }
      });
      await client.connect(
        transport,
        // The default 60s is not enough for a cold `uvx pkg@latest`, which
        // downloads the whole dependency tree before it says a word.
        { timeout: STDIO_STARTUP_TIMEOUT_MS },
      );
    } else if (server.url) {
      return this.connectHttp(server, client, interactive);
    } else {
      throw new Error(`MCP server "${server.name}" has neither a command nor a url.`);
    }
    this.clients.set(server.name, client);
    return client;
  }

  /** Connect every configured server and collect its tools. A server that
   *  fails is recorded in status() and skipped — one broken entry must not
   *  take Ask down, but it must not vanish silently either. */
  async tools(opts: { interactive?: boolean } = {}): Promise<AskTool[]> {
    const servers = parseMcpConfig(this.getConfigJson());
    const out: AskTool[] = [];
    for (const server of servers) {
      const transport = server.command ? "stdio" : "http";
      try {
        const client = await this.connect(server, opts.interactive === true);
        const listed = await client.listTools();
        this.statuses.set(server.name, {
          name: server.name,
          transport,
          ok: true,
          toolCount: listed.tools.length,
        });
        for (const tool of listed.tools) {
          const fullName = `${sanitize(server.name)}__${sanitize(tool.name)}`;
          out.push({
            name: fullName,
            description: `[${server.name}] ${tool.description ?? tool.name}`,
            parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as unknown as TSchema,
            statusFor: () => `${server.name}: ${tool.name}…`,
            needsApproval: () => ({ action: `${server.name}: ${tool.name}` }),
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
        const needsAuth = e instanceof SignInRequired;
        const error = needsAuth ? "not signed in" : explainMcpError(e, server);
        this.statuses.set(server.name, { name: server.name, transport, ok: false, toolCount: 0, error, needsAuth });
        // A failed connect leaves no reusable client behind.
        this.clients.delete(server.name);
        console.warn(`[covault] MCP server "${server.name}" unavailable: ${error}`, e);
      }
    }
    return out;
  }

  async dispose(): Promise<void> {
    // A listener left bound would hold the port past plugin unload.
    this.receiver.close();
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
