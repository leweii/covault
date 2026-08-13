/**
 * isomorphic-git HttpClient over Obsidian's requestUrl.
 *
 * requestUrl runs outside the renderer's CORS rules, so no proxy is
 * needed, but it cannot stream: request and response bodies are fully
 * buffered. Fine for knowledge repos (markdown-sized payloads).
 *
 * The gzip handling mirrors obsidian-git's hard-won behavior: ask for an
 * uncompressed response, and if one still arrives gzipped (a proxy that
 * ignores Accept-Encoding, a platform that inflates but keeps the header,
 * or vice versa) detect it by magic bytes — trusting Content-Encoding
 * risks double-inflating and corrupting the packfile.
 */
import { requestUrl } from "obsidian";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";

async function collect(iterator: AsyncIterableIterator<Uint8Array> | Uint8Array[]): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of iterator) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/** Inflate iff the body starts with the gzip magic bytes (0x1f 0x8b). A git
 *  smart-HTTP body never does — it starts with a pkt-line length or "PACK". */
async function inflateIfGzipped(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer;
  try {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).arrayBuffer();
  } catch {
    return buffer;
  }
}

function toAsyncIterator(buffer: ArrayBuffer): AsyncIterableIterator<Uint8Array> {
  let done = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (done) return { done: true, value: undefined };
      done = true;
      return { done: false, value: new Uint8Array(buffer) };
    },
  } as AsyncIterableIterator<Uint8Array>;
}

export const obsidianHttp: HttpClient = {
  async request({ url, method, headers, body }: GitHttpRequest): Promise<GitHttpResponse> {
    const collectedBody = body ? await collect(body) : undefined;

    const res = await requestUrl({
      url,
      method,
      headers: { "Accept-Encoding": "identity", ...headers },
      body: collectedBody,
      throw: false,
    });

    const responseBuffer = await inflateIfGzipped(res.arrayBuffer);

    return {
      url,
      method,
      headers: res.headers,
      body: toAsyncIterator(responseBuffer),
      statusCode: res.status,
      statusMessage: String(res.status),
    };
  },
};
