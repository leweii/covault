/**
 * isomorphic-git HttpClient over Node's http/https.
 *
 * Replaces the requestUrl-based client, which had three problems that all
 * showed up on large libraries:
 *
 *  - It buffers request and response bodies whole, so a big packfile is
 *    held in memory twice and a slow one looks identical to a dead one.
 *  - It takes no abort signal, so a timeout could only stop *waiting*: the
 *    transfer carried on writing, which is how a sync reported failure and
 *    then turned out to have worked.
 *  - Its only possible limit was a wall clock, which cannot tell a large
 *    transfer from a stalled one.
 *
 * Node's client streams, so the limit here is idle time — bytes have to
 * keep arriving, not arrive quickly — and a breach destroys the socket for
 * real. CORS doesn't apply outside the renderer's fetch, which is why
 * requestUrl was used in the first place.
 */
import * as http from "http";
import * as https from "https";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import type { DebugLog } from "./../debug/logger";

/**
 * How long a transfer may make no progress at all. Not a total budget: a
 * packfile that takes ten minutes but never stops arriving is fine, while
 * thirty seconds of silence means nothing is coming.
 */
const IDLE_TIMEOUT_MS = 30_000;

async function collect(body: AsyncIterableIterator<Uint8Array> | Uint8Array[]): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/** Response body as an async iterator, with idle-timeout enforcement. */
function streamBody(res: http.IncomingMessage, onByte: (n: number) => void): AsyncIterableIterator<Uint8Array> {
  const iterator = res[Symbol.asyncIterator]() as AsyncIterableIterator<Buffer>;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      const step = await iterator.next();
      if (!step.done) onByte(step.value.byteLength);
      return step as IteratorResult<Uint8Array>;
    },
  } as AsyncIterableIterator<Uint8Array>;
}

export function createNodeHttp(log?: DebugLog): HttpClient {
  return {
    async request({ url, method, headers, body }: GitHttpRequest): Promise<GitHttpResponse> {
      const sent = body ? await collect(body) : undefined;
      // Path only: a git query string carries ref names and can carry
      // credentials.
      const route = `${method} ${url.split("?")[0]}`;
      const done = log?.time("http", route, { requestBytes: sent?.byteLength ?? 0 });
      const target = new URL(url);
      const transport = target.protocol === "http:" ? http : https;

      return new Promise<GitHttpResponse>((resolve, reject) => {
        let received = 0;
        const req = transport.request(
          target,
          {
            method: method ?? "GET",
            headers: { ...headers, ...(sent ? { "Content-Length": String(sent.byteLength) } : {}) },
          },
          (res) => {
            // Re-armed by every chunk, so the clock measures silence
            // rather than duration.
            res.setTimeout(IDLE_TIMEOUT_MS, () => {
              res.destroy(new Error(`${route} stalled — no data for ${IDLE_TIMEOUT_MS / 1000}s`));
            });
            resolve({
              url,
              method,
              headers: res.headers as Record<string, string>,
              body: streamBody(res, (n) => {
                received += n;
                res.setTimeout(IDLE_TIMEOUT_MS);
              }),
              statusCode: res.statusCode ?? 0,
              statusMessage: res.statusMessage ?? String(res.statusCode ?? 0),
            });
            res.on("end", () => done?.({ status: res.statusCode, responseBytes: received }));
            res.on("error", (e) => {
              log?.op("http", `${route} — failed mid-body`, { error: e, responseBytes: received });
              done?.({ outcome: "error", responseBytes: received });
            });
          },
        );
        // Before the response starts, silence is the connection failing to
        // establish; destroying it is what makes the limit real.
        req.setTimeout(IDLE_TIMEOUT_MS, () => {
          req.destroy(new Error(`${route} stalled — no response for ${IDLE_TIMEOUT_MS / 1000}s`));
        });
        req.on("error", (e) => {
          log?.op("http", `${route} — failed`, { error: e });
          done?.({ outcome: "error" });
          reject(e);
        });
        if (sent) req.write(sent);
        req.end();
      });
    },
  };
}
