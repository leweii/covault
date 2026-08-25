/**
 * The bug these cover: a connected service that failed to start was
 * skipped with a console.warn, so Ask lost its tools and looked like it
 * was refusing to help. Failures now have to be reportable and the
 * messages have to name the fix.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { explainMcpError, McpManager, parseMcpConfig } from "../src/llm/mcp";
import {
  LoopbackAuthReceiver,
  McpAuthStore,
  McpOAuthProvider,
  MCP_CALLBACK_PORT,
  MCP_REDIRECT_URI,
  serverForState,
} from "../src/llm/mcpOAuth";

describe("parseMcpConfig", () => {
  it("reads the Claude Desktop shape", () => {
    const out = parseMcpConfig('{"mcpServers": {"atlassian": {"type": "http", "url": "https://mcp.atlassian.com/v1/mcp"}}}');
    expect(out).toEqual([{ name: "atlassian", type: "http", url: "https://mcp.atlassian.com/v1/mcp" }]);
  });

  it("reads a stdio server", () => {
    const out = parseMcpConfig('{"mcpServers": {"docs": {"command": "npx", "args": ["-y", "x"]}}}');
    expect(out[0]).toMatchObject({ name: "docs", command: "npx", args: ["-y", "x"] });
  });

  it("drops entries with neither a command nor a url", () => {
    expect(parseMcpConfig('{"mcpServers": {"broken": {"type": "http"}}}')).toEqual([]);
  });

  it("is empty for empty input and throws on malformed JSON", () => {
    expect(parseMcpConfig("")).toEqual([]);
    expect(() => parseMcpConfig("{nope")).toThrow(/not valid JSON/);
  });
});

describe("explainMcpError", () => {
  const http = { name: "atlassian", url: "https://mcp.atlassian.com/v1/mcp" };

  it("turns a 401 into the sign-in that is now possible", () => {
    for (const raw of ["HTTP 401", "Unauthorized", "invalid_token"]) {
      expect(explainMcpError(new Error(raw), http)).toMatch(/sign-in/);
    }
  });

  it("names the PATH problem and how to fix it", () => {
    const msg = explainMcpError(new Error("spawn npx ENOENT"), { name: "docs", command: "npx" });
    expect(msg).toContain("isn't on the PATH");
    expect(msg).toContain("which npx");
  });

  it("passes an unrecognized failure through rather than inventing a cause", () => {
    expect(explainMcpError(new Error("socket hang up"), http)).toBe("socket hang up");
  });
});

describe("McpAuthStore", () => {
  function store(): McpAuthStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covault-mcpauth-"));
    const s = new McpAuthStore();
    // Redirect the store at a temp file rather than the real config dir.
    (s as unknown as { file: string }).file = path.join(dir, "mcp-auth.json");
    return s;
  }

  it("starts empty and round-trips per server", () => {
    const s = store();
    expect(s.get("atlassian")).toEqual({});
    s.update("atlassian", { tokens: { access_token: "tok", token_type: "Bearer" } });
    s.update("datadog", { tokens: { access_token: "other", token_type: "Bearer" } });
    expect(s.get("atlassian").tokens?.access_token).toBe("tok");
    expect(s.get("datadog").tokens?.access_token).toBe("other");
  });

  it("merges patches instead of replacing the server's state", () => {
    const s = store();
    s.update("a", { codeVerifier: "v" });
    s.update("a", { tokens: { access_token: "t", token_type: "Bearer" } });
    expect(s.get("a").codeVerifier).toBe("v");
  });

  it("lists only servers holding a token", () => {
    const s = store();
    s.update("signed-in", { tokens: { access_token: "t", token_type: "Bearer" } });
    s.update("mid-flow", { codeVerifier: "v" });
    expect(s.authorized()).toEqual(["signed-in"]);
  });

  it("clears one server without touching the others", () => {
    const s = store();
    s.update("a", { tokens: { access_token: "t", token_type: "Bearer" } });
    s.update("b", { tokens: { access_token: "u", token_type: "Bearer" } });
    s.clear("a");
    expect(s.get("a")).toEqual({});
    expect(s.get("b").tokens?.access_token).toBe("u");
  });

  it("writes the token file readable only by the user", () => {
    const s = store();
    s.update("a", { tokens: { access_token: "t", token_type: "Bearer" } });
    const file = (s as unknown as { file: string }).file;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("survives a corrupt file instead of throwing", () => {
    const s = store();
    fs.mkdirSync(path.dirname((s as unknown as { file: string }).file), { recursive: true });
    fs.writeFileSync((s as unknown as { file: string }).file, "{ half written");
    expect(s.get("a")).toEqual({});
  });
});

describe("serverForState", () => {
  function store(): McpAuthStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covault-mcpstate-"));
    const s = new McpAuthStore();
    (s as unknown as { file: string }).file = path.join(dir, "mcp-auth.json");
    return s;
  }

  it("matches a redirect back to the server that started it", () => {
    const s = store();
    s.update("atlassian", { state: "atlassian:abc" });
    expect(serverForState(s, "atlassian:abc")).toBe("atlassian");
  });

  it("rejects a state that doesn't match what was stored (CSRF)", () => {
    const s = store();
    s.update("atlassian", { state: "atlassian:abc" });
    expect(serverForState(s, "atlassian:forged")).toBeNull();
    expect(serverForState(s, undefined)).toBeNull();
    expect(serverForState(s, "unknown:abc")).toBeNull();
  });
});

describe("the redirect URI", () => {
  /**
   * Loopback, not obsidian://. A custom scheme registers fine but dies at
   * authorization under an Atlassian org's redirect-URL allowlist ("your
   * organization admin must authorize access from this redirect URL"),
   * which is why every desktop MCP client uses http://localhost.
   */
  it("is a loopback callback", () => {
    expect(MCP_REDIRECT_URI).toBe(`http://localhost:${MCP_CALLBACK_PORT}/callback`);
    expect(new URL(MCP_REDIRECT_URI).protocol).toBe("http:");
  });

  it("doesn't collide with the port Claude Code uses", () => {
    expect(MCP_CALLBACK_PORT).not.toBe(3118);
  });
});

describe("LoopbackAuthReceiver", () => {
  /** One instance, like production: McpManager owns a single receiver, and
   *  the port is fixed because the redirect URI is baked into the client
   *  registration. Separate instances would just fight over it. */
  let receiver: LoopbackAuthReceiver;

  beforeEach(() => {
    // Port 0: an OS-assigned free port, so these never collide with the
    // plugin running in Obsidian (which holds the real one while waiting).
    receiver = new LoopbackAuthReceiver(0);
  });
  afterEach(async () => {
    await receiver.close();
  });

  async function hit(query: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${receiver.boundPort}/callback${query}`);
    return res.status;
  }

  it("resolves with the redirect's query params, then stops listening", async () => {
    await receiver.start();
    const waiting = receiver.result;
    expect(await hit("?code=abc&state=atlassian:xyz")).toBe(200);
    await expect(waiting).resolves.toEqual({ code: "abc", state: "atlassian:xyz" });
    expect(receiver.listening).toBe(false);
  });

  it("passes an error redirect through instead of hanging", async () => {
    await receiver.start();
    const waiting = receiver.result;
    await hit("?error=access_denied");
    await expect(waiting).resolves.toMatchObject({ error: "access_denied" });
  });

  it("ignores paths that aren't the callback", async () => {
    await receiver.start();
    const waiting = receiver.result;
    const stray = await fetch(`http://127.0.0.1:${receiver.boundPort}/favicon.ico`);
    expect(stray.status).toBe(404);
    expect(receiver.listening).toBe(true);
    await hit("?code=c&state=s");
    await waiting;
  });

  it("binds loopback only, so nothing off the machine can answer for the user", async () => {
    await receiver.start();
    const waiting = receiver.result.catch((e: Error) => e);
    const addr = (receiver as unknown as { server: { address(): { address: string } } }).server.address();
    expect(addr.address).toBe("127.0.0.1");
    await receiver.close();
    expect(await waiting).toBeInstanceOf(Error);
  });

  /** Cancelling has to end the wait: connectHttp awaits this promise, and
   *  a sign-in the user walked away from would otherwise hang forever. */
  it("rejects the pending wait when it is closed", async () => {
    await receiver.start();
    const waiting = receiver.result;
    await receiver.close();
    await expect(waiting).rejects.toThrow(/cancelled/);
  });

  /** Pressing "Test" twice must not fail on our own not-yet-freed socket. */
  it("can be restarted immediately after finishing", async () => {
    await receiver.start();
    const first = receiver.result;
    await hit("?code=one&state=s");
    await first;
    await receiver.start();
    const second = receiver.result;
    await hit("?code=two&state=s");
    await expect(second).resolves.toMatchObject({ code: "two" });
  });

  it("reports a port held by someone else as something the user can fix", async () => {
    await receiver.start();
    const waiting = receiver.result.catch(() => null);
    const rival = new LoopbackAuthReceiver(receiver.boundPort);
    await expect(rival.start()).rejects.toThrow(/busy/);
    await receiver.close();
    await waiting;
  });
});

describe("a registration made for a different redirect URI", () => {
  function provider(): { p: McpOAuthProvider; store: McpAuthStore } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covault-redirect-"));
    const store = new McpAuthStore();
    (store as unknown as { file: string }).file = path.join(dir, "mcp-auth.json");
    return { p: new McpOAuthProvider("atlassian", store, () => {}), store };
  }

  /** The 500 from Atlassian: a client registered for obsidian:// reused
   *  against a localhost redirect. It has to re-register, not keep failing. */
  it("is discarded so the SDK registers a fresh one", () => {
    const { p, store } = provider();
    store.update("atlassian", {
      client: { client_id: "-z299DHsu7cIMBJ5" },
      redirectUri: "obsidian://covault-mcp-auth",
      tokens: { access_token: "stale", token_type: "Bearer" },
    });
    expect(p.clientInformation()).toBeUndefined();
    // And it's cleared, so the stale token can't be sent either.
    expect(store.get("atlassian").client).toBeUndefined();
    expect(store.get("atlassian").tokens).toBeUndefined();
  });

  it("also discards an entry from before the URI was recorded", () => {
    const { p, store } = provider();
    store.update("atlassian", { client: { client_id: "legacy" } });
    expect(p.clientInformation()).toBeUndefined();
  });

  it("keeps a registration made for the current redirect URI", () => {
    const { p } = provider();
    p.saveClientInformation({ client_id: "fresh" });
    expect(p.clientInformation()).toEqual({ client_id: "fresh" });
  });
});

/**
 * The behaviour the user asked for: chatting must never be interrupted by
 * a sign-in. A silent connect refuses to open a browser and reports
 * needsAuth instead, so the question just goes without those tools.
 */
describe("connecting without interrupting the user", () => {
  function manager(opened: string[]): McpManager {
    const mcp = new McpManager(
      () => '{"mcpServers": {"atlassian": {"url": "http://127.0.0.1:1/mcp"}}}',
      () => ({}),
      (url) => opened.push(url),
    );
    isolate(mcp);
    return mcp;
  }

  /** A remote MCP server that always demands OAuth, served locally so the
   *  guarantee is tested without the network or real credentials. */
  async function fakeOAuthServer(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/.well-known/oauth-authorization-server") {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }
      if (path === "/register") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ client_id: "test-client", redirect_uris: [MCP_REDIRECT_URI] }));
        return;
      }
      // Everything else: the 401 that starts the whole dance.
      res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="OAuth"' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      close: () =>
        new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections?.();
        }),
    };
  }

  /** Isolate the token store: never read or write the real one. */
  function isolate(mcp: McpManager): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covault-mcpmgr-"));
    (mcp.auth as unknown as { file: string }).file = path.join(dir, "mcp-auth.json");
  }

  it("reports a server as needing sign-in without ever opening a browser", async () => {
    const fake = await fakeOAuthServer();
    const opened: string[] = [];
    const mcp = new McpManager(
      () => JSON.stringify({ mcpServers: { atlassian: { url: fake.url } } }),
      () => ({}),
      (url) => opened.push(url),
    );
    isolate(mcp);
    try {
      // A question's tool surface: silent by default.
      expect(await mcp.tools()).toEqual([]);
      expect(opened).toEqual([]); // the whole point
      expect(mcp.needingSignIn().map((s) => s.name)).toEqual(["atlassian"]);
      expect(mcp.status()[0]?.error).toBe("not signed in");
      // It is an action to offer, not a breakage to report.
      expect(mcp.broken()).toEqual([]);
    } finally {
      await mcp.dispose();
      await fake.close();
    }
  });

  it("opens the browser only when sign-in is asked for explicitly", async () => {
    const fake = await fakeOAuthServer();
    const opened: string[] = [];
    const mcp = new McpManager(
      () => JSON.stringify({ mcpServers: { atlassian: { url: fake.url } } }),
      () => ({}),
      (url) => opened.push(url),
    );
    isolate(mcp);
    try {
      // Never completes (no redirect arrives), but it must get as far as
      // opening the authorization page.
      const attempt = mcp.signIn("atlassian").catch(() => null);
      await new Promise((r) => setTimeout(r, 400));
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain("/authorize");
      expect(opened[0]).toContain("code_challenge");
      mcp.cancelAuth();
      await attempt;
    } finally {
      await mcp.dispose();
      await fake.close();
    }
  });

  it("separates servers needing sign-in from servers that are broken", async () => {
    const mcp = new McpManager(
      () => '{"mcpServers": {"nope": {"command": "definitely-not-installed-xyz"}}}',
      () => ({}),
      () => {},
    );
    await mcp.tools();
    expect(mcp.needingSignIn()).toEqual([]);
    expect(mcp.broken().map((s) => s.name)).toEqual(["nope"]);
    await mcp.dispose();
  });

  it("refuses to sign in to a server that isn't configured", async () => {
    const mcp = manager([]);
    await expect(mcp.signIn("ghost")).rejects.toThrow(/isn't in the connected-services config/);
    await mcp.dispose();
  });

  it("treats a server never contacted as neither broken nor needing sign-in", () => {
    const mcp = manager([]);
    expect(mcp.status()[0]?.error).toBe("not contacted yet");
    expect(mcp.broken()).toEqual([]);
    expect(mcp.needingSignIn()).toEqual([]);
  });
});
