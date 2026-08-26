/**
 * The debug log exists to be pasted into bug reports, so redaction is the
 * part that has to hold: a leaked token here travels further than the log.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DebugLog, redact } from "../src/debug/logger";
import { vaultKey } from "../src/config/secretStore";

describe("redact", () => {
  it("strips credentials from a URL's userinfo", () => {
    expect(redact("https://x-access-token:ghp_secret@github.com/acme/kb.git")).toBe(
      "https://<redacted>@github.com/acme/kb.git",
    );
  });

  it("scrubs token-shaped strings wherever they appear", () => {
    expect(redact("failed with github_pat_11ABCDEFG0abcdefghijklm")).toBe("failed with <redacted>");
    expect(redact("bad creds: ghs_AbCdEfGh0123456789xyz")).toBe("bad creds: <redacted>");
  });

  it("drops secret-named keys at any depth", () => {
    const out = redact({ headers: { Authorization: "Basic abc", accept: "*/*" } }) as Record<
      string,
      Record<string, string>
    >;
    expect(out.headers.Authorization).toBe("<redacted>");
    expect(out.headers.accept).toBe("*/*");
  });

  it("keeps the numbers a diagnosis needs", () => {
    expect(redact({ ms: 1234, responseBytes: 98765, ok: false })).toEqual({
      ms: 1234,
      responseBytes: 98765,
      ok: false,
    });
  });

  it("truncates long strings instead of dumping content", () => {
    const out = redact("x".repeat(1000)) as string;
    expect(out.length).toBeLessThan(400);
    expect(out).toContain("1000 chars");
  });

  it("reduces an Error to name and message", () => {
    expect(redact(new Error("push failed for ghp_abcdefghij0123456789"))).toEqual({
      name: "Error",
      message: "push failed for <redacted>",
    });
  });
});

describe("DebugLog", () => {
  function makeLog(enabled: boolean) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covault-log-"));
    return { dir, log: new DebugLog({ fs, enabled: () => enabled, logDir: () => dir }) };
  }

  it("records nothing while disabled", () => {
    const { dir, log } = makeLog(false);
    log.log("http", "GET /info/refs");
    expect(log.snapshot()).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "covault.log"))).toBe(false);
  });

  it("writes to both the ring and the file when enabled", () => {
    const { dir, log } = makeLog(true);
    log.log("http", "GET /info/refs", { status: 200 });
    expect(log.snapshot()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "covault.log"), "utf8")).toContain("[http] GET /info/refs");
  });

  it("times an operation and reports elapsed ms", () => {
    const { log } = makeLog(true);
    log.time("clone", "/vault/kb")();
    const messages = log.snapshot().map((e) => e.message);
    expect(messages).toEqual(["/vault/kb — started", "/vault/kb — done"]);
    expect(log.snapshot()[1]?.data?.ms).toBeTypeOf("number");
  });

  it("hands back a no-op finisher while disabled", () => {
    const { log } = makeLog(false);
    expect(() => log.time("clone", "/vault/kb")()).not.toThrow();
    expect(log.snapshot()).toHaveLength(0);
  });

  it("clears the ring and the file", () => {
    const { dir, log } = makeLog(true);
    log.log("http", "GET /info/refs");
    log.clear();
    expect(log.snapshot()).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "covault.log"))).toBe(false);
  });

  it("redacts before anything reaches disk", () => {
    const { dir, log } = makeLog(true);
    log.log("push", "failed", { url: "https://x:ghp_abcdefghij0123456789@github.com/acme/kb.git" });
    const written = fs.readFileSync(path.join(dir, "covault.log"), "utf8");
    expect(written).not.toContain("ghp_abcdefghij0123456789");
    expect(written).toContain("<redacted>");
  });
});

describe("operations level", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "covault-oplog-"));

  it("records op()/opTime() even with debug mode off", () => {
    const dir = tmp();
    const log = new DebugLog({ fs, enabled: () => false, logDir: () => dir });
    log.op("commit", "vault", { files: 3 });
    const done = log.opTime("push", "vault");
    done({ ok: true });
    expect(log.snapshot().map((e) => e.scope)).toEqual(["commit", "push", "push"]);
    expect(fs.readFileSync(path.join(dir, "covault.log"), "utf8")).toContain("[commit] vault");
    // Verbose stays gated.
    log.log("http", "GET /x");
    expect(log.snapshot().some((e) => e.scope === "http")).toBe(false);
  });

  it("redacts operation data too", () => {
    const dir = tmp();
    const log = new DebugLog({ fs, enabled: () => false, logDir: () => dir });
    log.op("push", "https://x:ghp_abcdefghijklmnop1234@github.com/o/r.git");
    expect(log.format()).not.toContain("ghp_abcdefghijklmnop1234");
  });
});

describe("where the log lives", () => {
  /**
   * The bug: the log used to sit in .covault/logs/ inside the vault. A
   * synced vault (iCloud, Dropbox, Obsidian Sync) then hands the same file
   * to several machines, which all append to it — one machine's failures
   * appear in another's log, and the paths in it belong to whichever home
   * directory wrote the line. Per-device, keyed by vault, fixes both.
   */
  it("keys the directory by vault, so two vaults on one machine stay apart", () => {
    const a = vaultKey("/Users/me/vault-one");
    const b = vaultKey("/Users/me/vault-two");
    expect(a).not.toBe(b);
    expect(a).toBe(vaultKey("/Users/me/vault-one")); // stable
  });

  it("does not leak the vault path into the directory name", () => {
    expect(vaultKey("/Users/me/Secret Project")).not.toContain("Secret");
    expect(vaultKey("/Users/me/Secret Project")).toMatch(/^[0-9a-f]{16}$/);
  });
});
