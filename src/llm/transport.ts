/**
 * The model API's HTTP layer, instrumented.
 *
 * A failed request reaches the user as the provider SDK's message, and the
 * Anthropic SDK's is the bare string "Connection error." The reason it
 * failed — a proxy refusing CONNECT, an intercepted TLS handshake, a DNS
 * miss, a blocked host — lives on that error's `.cause`, which both pi-ai
 * (which keeps only `error.message`) and pi-agent-core (same) discard on
 * the way to the panel. pi-ai does let a caller supply the fetch used for
 * provider requests, and that is the last place the original error still
 * exists, so we pass our own: it records what actually went wrong and
 * writes one line per request to the debug log, which until now had
 * nothing at all to say about Ask.
 *
 * A wrapper is still not enough on its own. When a server answers without
 * CORS headers — an edge 403 for a blocked region, say — the renderer's
 * fetch refuses to hand over the status at all and rejects as if the
 * network were down, so the cause chain says only "Failed to fetch". For
 * that case the probe takes a second look through a transport that isn't
 * subject to CORS (see `diagnose`), which is the only way the status code
 * reaches the user.
 */
import { extractDiagnosticError, type FetchFunction } from "@earendil-works/pi-ai";

/**
 * Flatten an error and everything it was caused by into one line.
 *
 * Node's `fetch` reports every network failure as "fetch failed" and puts
 * the diagnosis one or two levels down the `cause` chain, so the useful
 * part is never the top message. Each level goes through pi-ai's own
 * extractor (numeric codes, name fallback for empty messages) — only the
 * cause walk is ours.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    const info = extractDiagnosticError(current);
    const message = info.message.trim();
    if (message && !parts.includes(message)) parts.push(message);
    if (info.code !== undefined && !parts.includes(String(info.code))) parts.push(String(info.code));
    if (!(current instanceof Error)) break;
    current = (current as { cause?: unknown }).cause;
    if (current == null) break;
  }
  if (parts.length === 0) parts.push(String(error));
  return parts.join(" — ");
}

/**
 * Ask a non-CORS transport what the server actually says, as one line.
 *
 * Returns null when it can't add anything. Supplied by the plugin (Obsidian's
 * requestUrl runs in the main process); left out in tests.
 */
export type DiagnoseFn = (url: string) => Promise<string | null>;

export interface TransportProbe {
  /** Pass as `fetch` in the pi-ai stream options. */
  fetch: FetchFunction;
  /** The last request failure, flattened, or null if none since reset(). */
  lastFailure: string | null;
  /** Forget the previous question's failure. */
  reset(): void;
}

/** The URL a fetch input names, as a string. */
function urlOf(input: unknown): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : ((input as { url?: string } | null)?.url ?? "");
}

/** Host and path of a fetch input, for the log — never the query string. */
function describeTarget(input: unknown): string {
  const raw = urlOf(input);
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`;
  } catch {
    return raw || "unknown";
  }
}

export function createTransportProbe(
  log?: (line: string, failed: boolean) => void,
  base?: FetchFunction,
  diagnose?: DiagnoseFn,
): TransportProbe {
  // requestUrl is Obsidian's advice for network calls, but it buffers the
  // whole response — this transport carries streamed model output, so the
  // window's own fetch is the only thing that can back it.
  const send: FetchFunction = base ?? ((...args) => window.fetch(...args));
  const probe: TransportProbe = {
    lastFailure: null,
    reset() {
      probe.lastFailure = null;
    },
    fetch: async (input, init) => {
      const target = describeTarget(input);
      const started = Date.now();
      try {
        const response = await send(input, init);
        log?.(`${response.status} ${target} (${Date.now() - started}ms)`, response.status >= 400);
        // A request that reached the server clears the record — a later
        // model-side error must not be blamed on a transient failure an
        // eventual retry already recovered from.
        probe.lastFailure = null;
        return response;
      } catch (e) {
        // An aborted question is the user's doing, not a transport fault:
        // recording it would make the next real failure report the wrong
        // reason.
        const aborted = (e as { name?: string } | null)?.name === "AbortError" || init?.signal?.aborted === true;
        let detail = describeError(e);
        if (!aborted && diagnose) {
          // "Failed to fetch" can mean the request was answered and the
          // answer withheld. Only the second look can tell.
          const second = await diagnose(urlOf(input)).catch((probeError) => `probe failed: ${describeError(probeError)}`);
          if (second) detail = `${detail} — ${second}`;
        }
        log?.(`${aborted ? "aborted" : "FAILED"} ${target} (${Date.now() - started}ms): ${detail}`, !aborted);
        if (!aborted) probe.lastFailure = detail;
        throw e;
      }
    },
  };
  return probe;
}
