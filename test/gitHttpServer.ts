/**
 * Minimal git smart-HTTP server for integration tests: an HTTP server that
 * CGI-invokes the system `git http-backend` for every request. Test-only —
 * the plugin itself never shells out to git; this exists so the engine can
 * be exercised against a real remote without network access.
 */
import { spawn } from "child_process";
import * as http from "http";
import type { AddressInfo } from "net";

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
