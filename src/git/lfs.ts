/**
 * Git LFS, engine-side.
 *
 * Attachments are what make a knowledge repo heavy: every version of a
 * binary is a full blob, the history only ever grows, and every teammate
 * downloads all of it. With LFS the repo holds a ~130-byte text pointer
 * per attachment and the bytes live in the remote's LFS store, fetched on
 * demand and uploaded before the pointers are pushed.
 *
 * isomorphic-git has no clean/smudge filters, but the GitEngine owns every
 * path where content enters or leaves git, so the conversion lives there.
 * This module supplies the pieces: what counts as an attachment, the
 * pointer format, hashing, and the batch API client. The client speaks the
 * open LFS protocol against whatever the remote provides — GitHub's LFS
 * store today, anything else that implements the batch API later.
 */
import * as crypto from "crypto";
import type { GitHttpRequest, HttpClient } from "isomorphic-git";
import type { TokenProvider } from "../auth/TokenProvider";
import type { DebugLog } from "../debug/logger";
import { ownerFromUrl } from "./urls";

/** The spec caps a pointer file below 1 KiB — anything larger is content. */
export const POINTER_MAX_BYTES = 1024;

/**
 * Extension-based, like git-lfs itself, so the rule can be written into
 * .gitattributes verbatim and a teammate on plain git + git-lfs sees the
 * same behavior. A size threshold couldn't be expressed there, and a file
 * type that flips between pointer and raw depending on size is a mess.
 */
const LFS_EXTENSIONS = [
  // images (svg stays plain: it's small diffable text)
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "avif", "tiff", "tif", "heic",
  // audio
  "mp3", "wav", "m4a", "ogg", "flac", "aac", "3gp",
  // video
  "mp4", "mov", "mkv", "avi", "webm", "mpg", "mpeg",
  // documents & archives
  "pdf", "ppt", "pptx", "doc", "docx", "xls", "xlsx", "zip", "7z", "gz",
];

const LFS_EXTENSION_SET = new Set(LFS_EXTENSIONS);

/** Does this repo path hold an attachment (by extension)? */
export function isLfsPath(filepath: string): boolean {
  const dot = filepath.lastIndexOf(".");
  if (dot === -1) return false;
  return LFS_EXTENSION_SET.has(filepath.slice(dot + 1).toLowerCase());
}

/** The .gitattributes lines matching isLfsPath, for plain-git interop. */
export function gitattributesLines(): string[] {
  return LFS_EXTENSIONS.map((ext) => `*.${ext} filter=lfs diff=lfs merge=lfs -text`);
}

export interface LfsPointer {
  /** sha256 of the content, lowercase hex. */
  oid: string;
  size: number;
}

/** The canonical pointer file text (key order is fixed by the spec). */
export function formatPointer(pointer: LfsPointer): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${pointer.oid}\nsize ${pointer.size}\n`;
}

/** Parse pointer text; null when it isn't one (i.e. it's real content). */
export function parsePointer(text: string): LfsPointer | null {
  if (!text.startsWith("version https://git-lfs.github.com/spec/v1")) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  if (!oid || size === undefined) return null;
  return { oid, size: Number(size) };
}

export function sha256Bytes(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Streamed, so hashing a video doesn't hold it in memory. */
export function sha256File(fs: typeof import("fs"), absolutePath: string): Promise<LfsPointer> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let size = 0;
    const stream = fs.createReadStream(absolutePath);
    stream.on("data", (chunk) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(bytes);
      size += bytes.length;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ oid: hash.digest("hex"), size }));
  });
}

/** LFS endpoint for a remote: <url>[.git]/info/lfs — how git-lfs derives it. */
export function lfsEndpoint(repoUrl: string): string {
  const base = repoUrl.replace(/\/+$/, "");
  return `${/\.git$/i.test(base) ? base : `${base}.git`}/info/lfs`;
}

export interface LfsAction {
  href: string;
  header?: Record<string, string>;
}

export interface LfsBatchObject {
  oid: string;
  size: number;
  actions?: { download?: LfsAction; upload?: LfsAction; verify?: LfsAction };
  error?: { code: number; message: string };
}

/** What git-lfs itself sends per batch request. */
const BATCH_LIMIT = 100;

export interface LfsClientDeps {
  http: HttpClient;
  tokens: TokenProvider;
  log?: DebugLog;
}

export class LfsClient {
  constructor(private deps: LfsClientDeps) {}

  /**
   * One round-trip on the same HttpClient git uses, request body buffered —
   * LFS payloads are JSON or a single object, not a packfile negotiation.
   */
  private async request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<{ status: number; data: Buffer }> {
    const response = await this.deps.http.request({
      url,
      method,
      // GitHub rejects any request without a User-Agent outright (HTTP 403,
      // "Request forbidden by administrative rules") — lfs.github.com
      // enforces it on verify. isomorphic-git sends its own UA for git
      // traffic, which is why only the LFS calls ever tripped this.
      headers: { "User-Agent": "covault-lfs", ...headers },
      body: body ? ([body] as unknown as GitHttpRequest["body"]) : undefined,
    });
    const chunks: Buffer[] = [];
    if (response.body) {
      for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    }
    return { status: response.statusCode, data: Buffer.concat(chunks) };
  }

  /**
   * Ask the server what to do with these objects. For "download" it hands
   * back hrefs; for "upload" it returns actions only for objects it does
   * not already have — content addressing makes re-sharing a known file
   * free. Only this endpoint gets our credentials; action hrefs carry
   * their own (GitHub returns pre-signed URLs).
   */
  /** The Basic pair the LFS server itself wants — same as git-over-HTTPS. */
  private async basicAuth(repoUrl: string): Promise<string> {
    const token = await this.deps.tokens.getTokenForOwner(ownerFromUrl(repoUrl));
    return `Basic ${Buffer.from(`${this.deps.tokens.gitUser()}:${token}`).toString("base64")}`;
  }

  async batch(
    repoUrl: string,
    branch: string,
    operation: "download" | "upload",
    objects: { oid: string; size: number }[],
  ): Promise<LfsBatchObject[]> {
    const auth = await this.basicAuth(repoUrl);
    const url = `${lfsEndpoint(repoUrl)}/objects/batch`;
    const out: LfsBatchObject[] = [];
    for (let i = 0; i < objects.length; i += BATCH_LIMIT) {
      const slice = objects.slice(i, i + BATCH_LIMIT);
      const done = this.deps.log?.time("lfs", `batch ${operation}`, { objects: slice.length });
      const { status, data } = await this.request(
        url,
        "POST",
        {
          Accept: "application/vnd.git-lfs+json",
          "Content-Type": "application/vnd.git-lfs+json",
          Authorization: auth,
        },
        new TextEncoder().encode(
          JSON.stringify({
            operation,
            transfers: ["basic"],
            ref: { name: `refs/heads/${branch}` },
            objects: slice,
          }),
        ),
      );
      done?.({ status });
      if (status < 200 || status >= 300) {
        throw new Error(`LFS ${operation} refused by ${url} (HTTP ${status}): ${data.toString("utf8").slice(0, 200)}`);
      }
      out.push(...(JSON.parse(data.toString("utf8")) as { objects: LfsBatchObject[] }).objects);
    }
    return out;
  }

  /** Fetch one object's bytes, verified against its oid before use. */
  async download(object: LfsBatchObject): Promise<Buffer> {
    const action = object.actions?.download;
    if (!action) {
      throw new Error(`LFS object ${object.oid.slice(0, 8)}… unavailable: ${object.error?.message ?? "no download action"}`);
    }
    const done = this.deps.log?.time("lfs", "download", { oid: object.oid.slice(0, 8), size: object.size });
    const { status, data } = await this.request(action.href, "GET", action.header ?? {});
    done?.({ status });
    if (status < 200 || status >= 300) {
      throw new Error(`LFS download failed (HTTP ${status}) for ${object.oid.slice(0, 8)}…`);
    }
    if (sha256Bytes(data) !== object.oid) {
      throw new Error(`LFS object ${object.oid.slice(0, 8)}… arrived corrupted (hash mismatch)`);
    }
    return data;
  }

  /** Ship one object's bytes, then confirm via the verify action if given. */
  async upload(repoUrl: string, object: LfsBatchObject, data: Uint8Array): Promise<void> {
    const action = object.actions?.upload;
    if (!action) return; // the server already has it
    const done = this.deps.log?.time("lfs", "upload", { oid: object.oid.slice(0, 8), size: object.size });
    const put = await this.request(
      action.href,
      "PUT",
      { "Content-Type": "application/octet-stream", ...action.header },
      Buffer.from(data),
    );
    done?.({ status: put.status });
    if (put.status < 200 || put.status >= 300) {
      throw new Error(`LFS upload failed (HTTP ${put.status}) for ${object.oid.slice(0, 8)}…`);
    }
    const verify = object.actions?.verify;
    if (verify) {
      // Verify lives on the LFS server itself, not on pre-signed storage.
      // GitHub ships an Authorization inside verify.header (which wins via
      // the spread); the Basic pair is the fallback for servers that
      // expect the batch credentials instead of sending their own.
      const confirmed = await this.request(
        verify.href,
        "POST",
        {
          Accept: "application/vnd.git-lfs+json",
          "Content-Type": "application/vnd.git-lfs+json",
          Authorization: await this.basicAuth(repoUrl),
          ...verify.header,
        },
        new TextEncoder().encode(JSON.stringify({ oid: object.oid, size: object.size })),
      );
      if (confirmed.status < 200 || confirmed.status >= 300) {
        throw new Error(`LFS verify failed (HTTP ${confirmed.status}) for ${object.oid.slice(0, 8)}…`);
      }
    }
  }
}
