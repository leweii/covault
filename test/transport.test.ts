/**
 * The Ask path used to fail with "Connection error." and nothing else,
 * because every layer between the socket and the panel keeps only
 * `error.message`. These cover the two halves of the fix: reading the cause
 * chain, and the fetch wrapper that is close enough to the socket to have
 * one to read.
 */
import { describe, expect, it } from "vitest";
import { createTransportProbe, describeError } from "../src/llm/transport";

describe("describeError", () => {
  it("names the cause, not just the top-level message", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" });
    const detail = describeError(new Error("fetch failed", { cause }));
    expect(detail).toContain("fetch failed");
    expect(detail).toContain("ECONNREFUSED 127.0.0.1:8080");
  });

  it("reaches a diagnosis buried two levels down", () => {
    const tls = new Error("unable to verify the first certificate");
    const detail = describeError(new Error("Connection error.", { cause: new Error("fetch failed", { cause: tls }) }));
    expect(detail).toContain("unable to verify the first certificate");
  });

  it("keeps numeric codes and names an error with an empty message", () => {
    // Both come from pi-ai's own extractor, so its improvements ride along.
    const err = Object.assign(new Error("read failed"), { code: 4058 });
    expect(describeError(err)).toBe("read failed — 4058");
    expect(describeError(new Error(""))).toBe("Error");
  });

  it("survives a cycle and a non-error", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    a.cause = a;
    expect(describeError(a)).toBe("a");
    expect(describeError("plain string")).toBe("plain string");
  });
});

describe("transport probe", () => {
  it("records the real reason a request failed, and logs it", async () => {
    const lines: Array<[string, boolean]> = [];
    const probe = createTransportProbe(
      (line, failed) => lines.push([line, failed]),
      async () => {
        throw new Error("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), { code: "ENOTFOUND" }) });
      },
    );
    await expect(probe.fetch("https://api.anthropic.com/v1/messages?beta=true")).rejects.toThrow("fetch failed");
    expect(probe.lastFailure).toContain("ENOTFOUND");
    expect(lines[0]![0]).toContain("api.anthropic.com/v1/messages");
    // The query string never reaches the log — it can carry credentials.
    expect(lines[0]![0]).not.toContain("beta=true");
    expect(lines[0]![1]).toBe(true);
    probe.reset();
    expect(probe.lastFailure).toBe(null);
  });

  it("does not blame the transport when the user cancelled", async () => {
    const probe = createTransportProbe(undefined, async () => {
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    });
    await expect(probe.fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow();
    expect(probe.lastFailure).toBe(null);
  });

  /**
   * The Windows case: the server answered 403 at its edge, but the response
   * carried no CORS headers, so the renderer's fetch rejected with "Failed
   * to fetch" and the status never reached the SDK. Only the second look
   * can name it.
   */
  it("asks a non-CORS transport what the server really said", async () => {
    const asked: string[] = [];
    const probe = createTransportProbe(
      undefined,
      async () => {
        throw new TypeError("Failed to fetch");
      },
      async (url) => {
        asked.push(url);
        return "api.anthropic.com answered 403 via cloudflare: Request not allowed";
      },
    );
    await expect(probe.fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow("Failed to fetch");
    expect(asked).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(probe.lastFailure).toContain("403");
    expect(probe.lastFailure).toContain("Request not allowed");
  });

  it("still reports the cause when the second look itself fails", async () => {
    const probe = createTransportProbe(
      undefined,
      async () => {
        throw new Error("fetch failed", { cause: new Error("ETIMEDOUT") });
      },
      async () => {
        throw new Error("probe blew up");
      },
    );
    await expect(probe.fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow();
    expect(probe.lastFailure).toContain("ETIMEDOUT");
    expect(probe.lastFailure).toContain("probe blew up");
  });

  it("does not run the second look for a cancelled question", async () => {
    let looks = 0;
    const probe = createTransportProbe(
      undefined,
      async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
      async () => {
        looks += 1;
        return "unused";
      },
    );
    await expect(probe.fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow();
    expect(looks).toBe(0);
  });

  it("clears the recorded failure once a request gets through again", async () => {
    // A transient failure followed by a success must not be blamed for a
    // later model-side error ("the request never reached the model: …").
    let fail = true;
    const probe = createTransportProbe(undefined, async () => {
      if (fail) throw new Error("fetch failed", { cause: new Error("ETIMEDOUT") });
      return new Response("ok", { status: 200 });
    });
    await expect(probe.fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow();
    expect(probe.lastFailure).toContain("ETIMEDOUT");
    fail = false;
    await probe.fetch("https://api.anthropic.com/v1/messages");
    expect(probe.lastFailure).toBe(null);
  });

  it("passes a successful response through untouched, with its status logged", async () => {
    const lines: string[] = [];
    const body = new Response("ok", { status: 200 });
    const probe = createTransportProbe((line) => lines.push(line), async () => body);
    expect(await probe.fetch("https://api.anthropic.com/v1/messages")).toBe(body);
    expect(lines[0]).toContain("200 api.anthropic.com/v1/messages");
  });
});
