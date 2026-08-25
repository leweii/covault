/**
 * Pasted images on disk, beside the chat sessions.
 *
 * They deliberately do NOT live in chats.json: one screenshot is a
 * megabyte of base64, that file is re-read and re-parsed on every history
 * render, and it holds 50 sessions. So the JSON keeps a filename and the
 * bytes live here, one folder per session.
 */
import * as fs from "fs";
import * as path from "path";

/** What a ChatTurn stores instead of the pixels. */
export interface AttachmentRef {
  /** File name inside the session's folder. */
  file: string;
  mimeType: string;
  /** Original name, for the tooltip. */
  name: string;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

export class AttachmentStore {
  constructor(private root: string) {}

  private dirFor(sessionId: string): string {
    return path.join(this.root, sessionId);
  }

  /** Write one image, returning the reference to persist. */
  save(sessionId: string, image: { data: string; mimeType: string; name: string }, index: number): AttachmentRef {
    const dir = this.dirFor(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    // Content-independent but collision-free within a session: the turn
    // index alone would collide across turns.
    const file = `${Date.now().toString(36)}-${index}.${EXT[image.mimeType] ?? "png"}`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(image.data, "base64"));
    return { file, mimeType: image.mimeType, name: image.name };
  }

  /** Base64 again, for rendering a saved turn. Null if the file is gone. */
  read(sessionId: string, ref: AttachmentRef): string | null {
    try {
      return fs.readFileSync(path.join(this.dirFor(sessionId), ref.file)).toString("base64");
    } catch {
      return null;
    }
  }

  deleteSession(sessionId: string): void {
    fs.rmSync(this.dirFor(sessionId), { recursive: true, force: true });
  }

  /**
   * Drop folders for sessions that no longer exist — sessions age out of
   * chats.json silently, and their images would otherwise never be freed.
   */
  prune(liveSessionIds: string[]): void {
    const live = new Set(liveSessionIds);
    let entries: string[];
    try {
      entries = fs.readdirSync(this.root);
    } catch {
      return; // nothing written yet
    }
    for (const entry of entries) {
      if (!live.has(entry)) fs.rmSync(path.join(this.root, entry), { recursive: true, force: true });
    }
  }
}
