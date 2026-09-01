/**
 * Ask conversation persistence — device-local, deliberately outside the
 * vault's synced content (it lives in the plugin's own config dir):
 * conversations can quote personal notes and command output, and they
 * are one machine's working state, not team knowledge.
 *
 * One JSON file, newest-first, capped. Each session keeps two parallel
 * records: the display turns (what the view renders) and the raw agent
 * transcript (so resuming a session resumes the model's context too).
 */
import * as fs from "fs";
import * as path from "path";
import { AttachmentStore, type AttachmentRef } from "./attachmentStore";

export interface ChatTurn {
  question: string;
  answer?: string;
  activity: string[];
  error?: string;
  /** "wake" = the turn was opened by a background command finishing, not
   *  by the user typing; `question` is the report it carried. */
  kind?: "wake";
  /** Images pasted with the question — bytes live in the AttachmentStore. */
  images?: AttachmentRef[];
}

export interface ChatSession {
  id: string;
  /** First question, truncated — the list label. */
  title: string;
  updatedAt: number;
  turns: ChatTurn[];
  /** Raw agent messages (opaque here; the engine knows the shape). */
  transcript: unknown[];
}

const MAX_SESSIONS = 50;

export class ChatStore {
  /** Image bytes for these sessions, kept in step on save/delete. */
  readonly attachments: AttachmentStore;

  constructor(private file: string) {
    this.attachments = new AttachmentStore(path.join(path.dirname(file), "attachments"));
  }

  list(): ChatSession[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { sessions?: ChatSession[] };
      return (raw.sessions ?? []).filter((s) => typeof s?.id === "string");
    } catch {
      return [];
    }
  }

  /** Insert or update, newest first, capped at MAX_SESSIONS. */
  save(session: ChatSession): void {
    const rest = this.list().filter((s) => s.id !== session.id);
    const sessions = [session, ...rest].slice(0, MAX_SESSIONS);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, sessions }, null, 2));
    // Sessions that just fell off the end take their images with them.
    this.attachments.prune(sessions.map((s) => s.id));
  }

  delete(id: string): void {
    const sessions = this.list().filter((s) => s.id !== id);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, sessions }, null, 2));
    this.attachments.deleteSession(id);
  }
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function titleFor(question: string): string {
  const line = question.split("\n")[0]?.trim() ?? "";
  return line.length > 48 ? `${line.slice(0, 48)}…` : line || "New chat";
}
