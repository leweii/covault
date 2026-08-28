/**
 * The bug this file exists for: the idle watchdog was never disarmed when
 * a response finished. A keep-alive socket idles in the agent pool after a
 * completed response, so the timer fired later and destroyed a body whose
 * bytes had arrived long before — reported as "stalled — no data for 30s"
 * on whatever still held the iterator. It showed up as sporadic
 * info/refs failures during adopt, where the flow pauses between steps.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as http from "http";
import { createNodeHttp } from "../src/git/nodeHttp";

const IDLE = 150; // keep the tests fast; production uses 30s

let server: http.Server | null = null;
async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}/`;
}
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function drain(body: AsyncIterableIterator<Uint8Array>): Promise<string> {
  let out = "";
  for await (const chunk of body) out += Buffer.from(chunk).toString();
  return out;
}

describe("createNodeHttp", () => {
  it("returns status, headers and a streamed body", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "x-test": "yes" });
      res.end("hello");
    });
    const client = createNodeHttp(undefined, IDLE);
    const res = await client.request({ url, method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["x-test"]).toBe("yes");
    expect(await drain(res.body as AsyncIterableIterator<Uint8Array>)).toBe("hello");
  });

  /**
   * The regression. The watchdog used to keep running after a response
   * completed, so holding the body — which the adopt flow does between
   * steps — produced "stalled" on data that had already arrived.
   */
  it("does not stall a finished response that is read late", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { Connection: "keep-alive" });
      res.end("payload");
    });
    const client = createNodeHttp(undefined, IDLE);
    const res = await client.request({ url, method: "GET" });
    // Hold the body far longer than the idle window before reading it.
    await new Promise((r) => setTimeout(r, IDLE * 4));
    expect(await drain(res.body as AsyncIterableIterator<Uint8Array>)).toBe("payload");
  });

  it("sends a request body and reports its bytes", async () => {
    let seen = "";
    const url = await serve((req, res) => {
      req.on("data", (c: Buffer) => (seen += c.toString()));
      req.on("end", () => res.end("ok"));
    });
    const client = createNodeHttp(undefined, IDLE);
    const res = await client.request({ url, method: "POST", body: [Buffer.from("0009done\n")] });
    await drain(res.body as AsyncIterableIterator<Uint8Array>);
    expect(seen).toBe("0009done\n");
  });

  /**
   * The push-timeout regression: a large request body (a packfile, an LFS
   * upload) used to be written whole, so the "no response" watchdog fired
   * mid-upload — a slow uplink read as a dead server. Draining chunks are
   * progress; a server sipping the body far past the idle window must not
   * kill the request.
   */
  it("keeps a slow-draining upload alive past the idle window", async () => {
    const url = await serve((req, res) => {
      let received = 0;
      req.on("data", (c: Buffer) => {
        received += c.length;
        // Sip: pause after every read so the client's socket backs up and
        // its progress comes from drain events, not one buffered write.
        req.pause();
        setTimeout(() => req.resume(), IDLE / 4);
      });
      req.on("end", () => res.end(String(received)));
    });
    const client = createNodeHttp(undefined, IDLE);
    const body = Buffer.alloc(8 * 1024 * 1024, 7); // >> socket buffers
    const res = await client.request({ url, method: "POST", body: [body] });
    expect(await drain(res.body as AsyncIterableIterator<Uint8Array>)).toBe(String(body.byteLength));
  }, 30_000);

  it("gives up when a response never starts", async () => {
    const url = await serve(() => {
      /* accept the request, answer nothing */
    });
    const client = createNodeHttp(undefined, IDLE);
    await expect(client.request({ url, method: "GET" })).rejects.toThrow(/stalled — no response/);
  });

  it("gives up when a body stops mid-transfer", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "Content-Length": "100" });
      res.write("partial"); // never finishes
    });
    const client = createNodeHttp(undefined, IDLE);
    const res = await client.request({ url, method: "GET" });
    await expect(drain(res.body as AsyncIterableIterator<Uint8Array>)).rejects.toThrow(/stalled — no data/);
  });

  /** A slow-but-progressing transfer is the case a wall clock got wrong. */
  it("allows a transfer that takes far longer than the idle window", async () => {
    const url = await serve((_req, res) => {
      let n = 0;
      const tick = setInterval(() => {
        res.write("chunk");
        if (++n === 6) {
          clearInterval(tick);
          res.end();
        }
      }, IDLE / 2);
    });
    const client = createNodeHttp(undefined, IDLE);
    const res = await client.request({ url, method: "GET" });
    expect(await drain(res.body as AsyncIterableIterator<Uint8Array>)).toBe("chunk".repeat(6));
  });
});
