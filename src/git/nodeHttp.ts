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
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from "node:timers";

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

export function createNodeHttp(log?: DebugLog, idleMs: number = IDLE_TIMEOUT_MS): HttpClient {
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
        let responded = false;
        /**
         * The watchdog is armed only while we are genuinely waiting, and
         * disarmed the moment the body ends. Leaving it armed was a bug:
         * a keep-alive socket idles in the agent pool after a completed
         * response, so 30s later it fired and destroyed a response whose
         * data had arrived long before — surfacing as a stall on whatever
         * still held the iterator.
         */
        // Node timers, imported rather than ambient: this transport runs
        // on node:http, and unref is what stops a pending stall timer from
        // holding the process open — a DOM timer id has no such thing.
        let timer: NodeJS.Timeout | undefined;
        const disarm = () => {
          if (timer) clearNodeTimeout(timer);
          timer = undefined;
        };
        const arm = (onStall: () => void, ms = idleMs) => {
          disarm();
          timer = setNodeTimeout(onStall, ms);
          timer.unref?.();
        };

        const req = transport.request(
          target,
          {
            method: method ?? "GET",
            headers: { ...headers, ...(sent ? { "Content-Length": String(sent.byteLength) } : {}) },
          },
          (res) => {
            // The response has started, so the "no response" watchdog has
            // done its job. Leaving it armed destroyed the socket later —
            // and with it a body that had already arrived.
            responded = true;
            disarm();
            const stall = (why: string) => () => {
              disarm();
              res.destroy(new Error(`${route} stalled — ${why}`));
            };
            // The watchdog runs only while a read is outstanding. Silence
            // while nobody is reading is not a stall — the consumer may
            // legitimately hold the body for a while — and counting it as
            // one is what destroyed responses whose bytes had all arrived.
            // Counting bytes here rather than in an "data" listener also
            // matters: a listener switches the stream to flowing mode and
            // consumes the body before isomorphic-git ever iterates it.
            // Created on first read, not here: taking the iterator early
            // starts the stream consuming, and a body the caller has not
            // asked for yet is then lost.
            let source: AsyncIterableIterator<Buffer> | undefined;
            const watched: AsyncIterableIterator<Uint8Array> = {
              [Symbol.asyncIterator]() {
                return this;
              },
              async next() {
                source ??= res[Symbol.asyncIterator]() as AsyncIterableIterator<Buffer>;
                arm(stall(`no data for ${idleMs / 1000}s`));
                try {
                  const step = await source.next();
                  if (!step.done) received += step.value.byteLength;
                  return step as IteratorResult<Uint8Array>;
                } finally {
                  disarm();
                }
              },
            } as AsyncIterableIterator<Uint8Array>;
            res.on("end", () => done?.({ status: res.statusCode, responseBytes: received }));
            res.on("close", disarm);
            res.on("error", (e) => {
              disarm();
              log?.op("http", `${route} — failed mid-body`, { error: e, responseBytes: received });
              done?.({ outcome: "error", responseBytes: received });
            });
            resolve({
              url,
              method,
              headers: res.headers as Record<string, string>,
              body: watched,
              statusCode: res.statusCode ?? 0,
              statusMessage: res.statusMessage ?? String(res.statusCode ?? 0),
            });
          },
        );
        const noResponseAfter = (ms: number) => () => {
          disarm();
          req.destroy(new Error(`${route} stalled — no response for ${Math.round(ms / 1000)}s`));
        };
        const noResponse = noResponseAfter(idleMs);
        // Before a response exists, silence means the connection never came
        // up; destroying it is what makes the limit real.
        arm(noResponse);
        req.on("error", (e) => {
          disarm();
          log?.op("http", `${route} — failed`, { error: e });
          done?.({ outcome: "error" });
          reject(e);
        });
        if (sent) {
          // Drain-paced chunks, not one write: a large body — a push's
          // packfile, an LFS upload — legitimately spends minutes on the
          // wire before any response can exist, and writing it whole gave
          // the watchdog nothing to observe, so it fired mid-upload. Every
          // drained chunk is progress and re-arms it; a socket that stops
          // draining is the stall the watchdog exists for. (`responded`
          // guards the re-arm: once the reply has started, the response
          // side owns the watchdog.)
          const CHUNK = 256 * 1024;
          // The watchdog window while a body is in flight: enough time to
          // move what's still unacknowledged at a 50 KB/s floor, capped.
          // write() returning and even end() only mean the OS took the
          // bytes — its buffers hold megabytes that a slow uplink flushes
          // with nothing for us to observe, and drain timing is at the
          // mercy of kernel buffering. A dead socket is still caught, just
          // on a leash proportional to what could legitimately be pending.
          const windowFor = (remaining: number) => {
            const ms = Math.min(Math.ceil(remaining / (50 * 1024)) * 1000, 10 * 60_000);
            return Math.max(idleMs, ms);
          };
          let offset = 0;
          const pump = () => {
            while (offset < sent.byteLength) {
              const end = Math.min(offset + CHUNK, sent.byteLength);
              const flushed = req.write(sent.subarray(offset, end));
              offset = end;
              if (!responded) {
                const ms = windowFor(sent.byteLength - offset + CHUNK);
                arm(noResponseAfter(ms), ms);
              }
              if (!flushed) {
                req.once("drain", pump);
                return;
              }
            }
            req.end();
            if (!responded) {
              // Truly waiting for the reply — but the OS may still hold any
              // amount of the body, so the leash covers all of it.
              const ms = windowFor(sent.byteLength);
              arm(noResponseAfter(ms), ms);
            }
          };
          pump();
        } else {
          req.end();
        }
      });
    },
  };
}
