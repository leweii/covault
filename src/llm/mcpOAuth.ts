/**
 * OAuth for remote MCP servers (Atlassian, Datadog, Linear, …).
 *
 * These servers answer an unauthenticated request with 401 +
 * `WWW-Authenticate: Bearer realm="OAuth"`. The MCP SDK does the whole
 * dance itself — metadata discovery, dynamic client registration, PKCE,
 * token exchange and refresh — provided we hand it somewhere to put the
 * results and a way to open a browser. That is all this file is.
 *
 * The redirect comes back to a loopback HTTP server this file starts on
 * demand, not to an obsidian:// protocol handler. Custom schemes register
 * fine but fail at authorization time under an Atlassian organization's
 * redirect-URL allowlist policy ("your organization admin must authorize
 * access from this redirect URL"), while http://localhost is what every
 * desktop MCP client uses and what such policies already permit.
 *
 * State lives outside the vault, next to the other per-device secrets:
 * these are bearer tokens, and they must survive the restart that a
 * browser round-trip can easily involve.
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as crypto from "crypto";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { appConfigDir } from "../config/secretStore";

/**
 * Fixed, because the redirect URI is baked into the dynamic client
 * registration and must match byte-for-byte at token exchange — it cannot
 * be renegotiated once a flow is under way. Deliberately not 3118, which
 * Claude Code uses.
 */
export const MCP_CALLBACK_PORT = 51789;
export const MCP_REDIRECT_URI = `http://localhost:${MCP_CALLBACK_PORT}/callback`;

/** How long a browser sign-in may take before the listener gives up. */
const AUTH_TIMEOUT_MS = 5 * 60_000;

const DONE_PAGE = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Covault</title>` +
  `<body style="font:15px -apple-system,system-ui,sans-serif;padding:3rem;text-align:center;color:#222">` +
  `<p>${message}</p><p style="color:#888">You can close this tab and go back to Obsidian.</p>`;

/**
 * One-shot loopback listener for an OAuth redirect.
 *
 * Bound to 127.0.0.1 so nothing off the machine can reach it, closed as
 * soon as the code arrives (or the timeout fires) so it isn't sitting
 * around, and the caller still verifies `state` before trusting anything.
 */
export class LoopbackAuthReceiver {
  /** Overridable so tests don't fight the running plugin for the real
   *  port; 0 asks the OS for a free one. Production uses the default,
   *  which has to be fixed (see MCP_CALLBACK_PORT). */
  constructor(private port: number = MCP_CALLBACK_PORT) {}

  private server: http.Server | null = null;
  /** Settles the in-flight receive(). Held so close() can end the wait —
   *  a caller awaiting a sign-in the user abandoned must not hang. */
  private pending: { resolve: (p: Record<string, string>) => void; reject: (e: Error) => void } | null = null;

  get listening(): boolean {
    return this.server !== null;
  }

  /** The port actually bound — differs from `port` only when it was 0. */
  get boundPort(): number {
    const addr = this.server?.address();
    return typeof addr === "object" && addr ? addr.port : this.port;
  }

  /**
   * Bind the port. Resolves once actually listening — the browser must not
   * be opened before then, or a fast redirect hits a closed port. The
   * redirect itself is awaited separately, via result().
   */
  async start(): Promise<void> {
    await this.close(); // never two at once, and wait for the port back
    this.current = new Promise<Record<string, string>>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    // start() may reject before anyone awaits result(); keep that from
    // surfacing as an unhandled rejection.
    this.current.catch(() => {});
    return new Promise((listening, failed) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", MCP_REDIRECT_URI);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const params = Object.fromEntries(url.searchParams.entries());
        const problem = params.error ?? (params.code ? null : "no authorization code");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE(problem ? `Sign-in failed: ${problem}` : "Signed in — Covault has the connection."));
        this.settle((p) => p.resolve(params));
      });
      server.on("error", (e: NodeJS.ErrnoException) => {
        const reason =
          e.code === "EADDRINUSE"
            ? new Error(
                `Port ${this.port} is busy, so the sign-in has nowhere to return to. ` +
                  `Close whatever is using it and try again.`,
              )
            : e;
        this.settle((p) => p.reject(reason));
        failed(reason);
      });
      server.listen(this.port, "127.0.0.1", () => {
        this.server = server;
        const timer = setTimeout(() => {
          if (this.server === server) {
            this.settle((p) => p.reject(new Error("The sign-in wasn't finished in time — start it again.")));
          }
        }, AUTH_TIMEOUT_MS);
        timer.unref?.();
        listening();
      });
    });
  }

  /** Stop listening and settle exactly once. */
  private settle(finish: (p: { resolve: (p: Record<string, string>) => void; reject: (e: Error) => void }) => void): void {
    const pending = this.pending;
    this.pending = null;
    const server = this.server;
    this.server = null;
    // close() only *starts* releasing the socket; a bind attempted before
    // it completes fails with EADDRINUSE, which is what pressing "Test"
    // twice in a row would do. And it waits for open connections — the
    // browser keeps its keep-alive socket, so without dropping those the
    // port is never handed back at all.
    this.released = server
      ? new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections?.();
        })
      : Promise.resolve();
    if (pending) finish(pending);
  }

  /** Resolves once the port is actually free again. */
  private released: Promise<void> = Promise.resolve();

  private current: Promise<Record<string, string>> | null = null;

  /** The redirect this listener is waiting for. Built on access so an
   *  unused receiver doesn't leave a rejected promise nobody handles. */
  get result(): Promise<Record<string, string>> {
    return this.current ?? Promise.reject(new Error("No sign-in started."));
  }

  close(): Promise<void> {
    this.settle((p) => p.reject(new Error("The sign-in was cancelled.")));
    return this.released;
  }
}

interface ServerAuthState {
  client?: OAuthClientInformation | OAuthClientInformationFull;
  /**
   * The redirect URI `client` was registered for. A registration is only
   * usable with the URI it was created against — reusing one across a
   * change makes the authorization server reject the mismatch, which
   * Atlassian reports as a bare 500. Absent on entries written before
   * this was recorded, which are treated as stale for the same reason.
   */
  redirectUri?: string;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  /** CSRF: compared against the `state` the redirect carries back. */
  state?: string;
}

interface AuthFile {
  version: 1;
  servers: Record<string, ServerAuthState>;
}

/**
 * Per-device store for MCP OAuth state, one file for all servers.
 *
 * Deliberately not in the vault and not in data.json: it holds access and
 * refresh tokens, which are exactly what the rest of the plugin works hard
 * to keep out of synced files.
 */
export class McpAuthStore {
  private file = path.join(appConfigDir(), "mcp-auth.json");

  private read(): AuthFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as AuthFile;
      if (raw?.version === 1 && raw.servers) return raw;
    } catch {
      /* first run, or unreadable — start clean */
    }
    return { version: 1, servers: {} };
  }

  private write(data: AuthFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  get(server: string): ServerAuthState {
    return this.read().servers[server] ?? {};
  }

  update(server: string, patch: Partial<ServerAuthState>): void {
    const data = this.read();
    data.servers[server] = { ...(data.servers[server] ?? {}), ...patch };
    this.write(data);
  }

  clear(server: string): void {
    const data = this.read();
    delete data.servers[server];
    this.write(data);
  }

  /** Which servers currently hold a token — the settings page reports this. */
  authorized(): string[] {
    const data = this.read();
    return Object.keys(data.servers).filter((name) => data.servers[name]?.tokens?.access_token);
  }
}

/**
 * The SDK's OAuthClientProvider, backed by McpAuthStore.
 *
 * `saveClientInformation` is not optional in practice: without it the SDK
 * refuses to do dynamic registration, and remote MCP servers generally
 * expect exactly that (no client id is pre-issued to us).
 */
export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    private serverName: string,
    private store: McpAuthStore,
    /** Opens the authorization URL in the user's browser. */
    /** Starts the loopback listener, then opens the browser. Awaited by
     *  the SDK, so the listener is up before the redirect can arrive. */
    private openBrowser: (url: string) => void | Promise<void>,
  ) {}

  get redirectUrl(): string {
    return MCP_REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Covault (Obsidian)",
      redirect_uris: [MCP_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client: an Obsidian plugin can keep no secret.
      token_endpoint_auth_method: "none",
    };
  }

  /**
   * Returning undefined makes the SDK register a fresh client, so a
   * registration left over from a different redirect URI heals itself
   * instead of failing every sign-in from then on.
   */
  clientInformation(): OAuthClientInformation | undefined {
    const saved = this.store.get(this.serverName);
    if (!saved.client) return undefined;
    if (saved.redirectUri !== MCP_REDIRECT_URI) {
      this.store.update(this.serverName, { client: undefined, redirectUri: undefined, tokens: undefined });
      return undefined;
    }
    return saved.client;
  }

  saveClientInformation(info: OAuthClientInformation | OAuthClientInformationFull): void {
    this.store.update(this.serverName, { client: info, redirectUri: MCP_REDIRECT_URI });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.get(this.serverName).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.update(this.serverName, { tokens });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.update(this.serverName, { codeVerifier });
  }

  codeVerifier(): string {
    const saved = this.store.get(this.serverName).codeVerifier;
    if (!saved) throw new Error("No code verifier saved — start the sign-in again.");
    return saved;
  }

  /** The SDK never checks `state` coming back; the callback handler does,
   *  so it has to be stored on the way out. */
  state(): string {
    const value = `${this.serverName}:${crypto.randomBytes(16).toString("base64url")}`;
    this.store.update(this.serverName, { state: value });
    return value;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.openBrowser(authorizationUrl.toString());
  }

  /** Lets the SDK's retry paths drop what went stale instead of looping. */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.store.clear(this.serverName);
    else if (scope === "tokens") this.store.update(this.serverName, { tokens: undefined });
    else if (scope === "client") this.store.update(this.serverName, { client: undefined });
    else if (scope === "verifier") this.store.update(this.serverName, { codeVerifier: undefined });
  }
}

/** The server a returning redirect belongs to, if its state matches. */
export function serverForState(store: McpAuthStore, state: string | undefined): string | null {
  if (!state) return null;
  const name = state.split(":")[0];
  if (!name) return null;
  return store.get(name).state === state ? name : null;
}
