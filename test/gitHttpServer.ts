/**
 * Minimal git smart-HTTP server for integration tests: an HTTP server that
 * CGI-invokes the system `git http-backend` for every request. Test-only —
 * the plugin itself never shells out to git; this exists so the engine can
 * be exercised against a real remote without network access.
 *
 * It also speaks just enough Git LFS for the engine's attachment tests:
 * the batch endpoint plus a flat GET/PUT object store kept beside each
 * repo (<repo>.git/lfs-store/<oid>).
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";

export interface GitServer {
  /** Base URL, e.g. http://127.0.0.1:52341 — repos resolve under it. */
  url: string;
  close(): Promise<void>;
}

export async function startGitServer(projectRoot: string): Promise<GitServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://localhost");
      if (handleLfs(projectRoot, req, res, url, body)) return;
      const child = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.searchParams.toString(),
          REQUEST_METHOD: req.method ?? "GET",
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.byteLength),
          REMOTE_ADDR: "127.0.0.1",
        },
      });
      child.stdin.write(body);
      child.stdin.end();

      const out: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => process.stderr.write(`[git-http-backend] ${c}`));
      child.on("close", () => {
        // Parse the CGI response: header block, blank line, body.
        const raw = Buffer.concat(out);
        const sep = raw.indexOf("\r\n\r\n");
        const headerBlock = raw.subarray(0, sep).toString("utf8");
        const responseBody = raw.subarray(sep + 4);
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of headerBlock.split("\r\n")) {
          const idx = line.indexOf(":");
          if (idx === -1) continue;
          const name = line.slice(0, idx).trim();
          const value = line.slice(idx + 1).trim();
          if (name.toLowerCase() === "status") status = parseInt(value, 10);
          else headers[name] = value;
        }
        res.writeHead(status, headers);
        res.end(responseBody);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** True when the request was an LFS route and has been answered. */
function handleLfs(projectRoot: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: Buffer): boolean {
  const storePath = (repo: string, oid: string) => path.join(projectRoot, repo, "lfs-store", oid);

  const batch = /^\/(.+\.git)\/info\/lfs\/objects\/batch$/.exec(url.pathname);
  if (batch && req.method === "POST") {
    const repo = batch[1] as string;
    const { operation, objects } = JSON.parse(body.toString("utf8")) as {
      operation: "download" | "upload";
      objects: { oid: string; size: number }[];
    };
    const answered = objects.map(({ oid, size }) => {
      const exists = fs.existsSync(storePath(repo, oid));
      const href = `http://${req.headers.host}/${repo}/lfs-store/${oid}`;
      if (operation === "download") {
        return exists ? { oid, size, actions: { download: { href } } } : { oid, size, error: { code: 404, message: "object missing" } };
      }
      // The verify action mirrors GitHub: it lives on the LFS server and
      // rejects unauthenticated calls — regression cover for the 403 the
      // real endpoint returned when the client sent no credentials.
      const verify = { href: `http://${req.headers.host}/${repo}/lfs-verify/${oid}` };
      return exists ? { oid, size } : { oid, size, actions: { upload: { href }, verify } };
    });
    res.writeHead(200, { "Content-Type": "application/vnd.git-lfs+json" });
    res.end(JSON.stringify({ transfer: "basic", objects: answered }));
    return true;
  }

  const verify = /^\/(.+\.git)\/lfs-verify\/([0-9a-f]{64})$/.exec(url.pathname);
  if (verify && req.method === "POST") {
    if (!req.headers.authorization) {
      res.writeHead(403);
      res.end(JSON.stringify({ message: "credentials required" }));
      return true;
    }
    const ok = fs.existsSync(storePath(verify[1] as string, verify[2] as string));
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/vnd.git-lfs+json" });
    res.end("{}");
    return true;
  }

  const object = /^\/(.+\.git)\/lfs-store\/([0-9a-f]{64})$/.exec(url.pathname);
  if (object) {
    const file = storePath(object[1] as string, object[2] as string);
    if (req.method === "PUT") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      res.writeHead(200);
      res.end();
      return true;
    }
    if (req.method === "GET") {
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(fs.readFileSync(file));
      return true;
    }
  }
  return false;
}
