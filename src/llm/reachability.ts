/**
 * What the model endpoint says when CORS isn't in the way.
 *
 * Obsidian's requestUrl runs in the main process, so it sees status codes
 * the renderer's fetch will not hand over: a response without
 * `access-control-allow-origin` — an edge 403 for a blocked region, a WAF
 * challenge, a captive portal — makes fetch reject as though the network
 * were down. This turns that into "the server answered 403", which is a
 * different problem with a different fix.
 *
 * Sent unauthenticated on purpose: an edge block happens before auth, and
 * a 401 back is itself the answer (the endpoint is reachable, so the
 * failure is CORS or the local network stack, not the host).
 */
import { requestUrl } from "obsidian";

/** Cloudflare error pages run long; the useful part is the first line. */
const MAX_BODY = 200;

export async function describeEndpoint(url: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  const res = await requestUrl({
    url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    throw: false,
  });
  const body = (res.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_BODY);
  const server = res.headers?.["server"] ?? res.headers?.["Server"];
  const via = server ? ` via ${server}` : "";
  if (res.status === 401 || res.status === 403 || res.status >= 500 || res.status === 429) {
    return `${host} answered ${res.status}${via}${body ? `: ${body}` : ""}`;
  }
  // Any other status means the host is reachable and talking sense, so the
  // renderer is what refused — CORS, most likely.
  return `${host} is reachable (answered ${res.status}${via}) — the browser layer refused the request, not the network`;
}
