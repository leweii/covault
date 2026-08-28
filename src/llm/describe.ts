/**
 * One-line library descriptions, LLM-drafted from a library's README and
 * structure. Generated once per library — at create/add time, or via the
 * backfill command — and stored in the manifest, so the whole team gets
 * the same text through sync and only one device ever spends the tokens.
 * (Adapters must stay deterministic; a stored description is, a fresh
 * LLM call is not.)
 */
import { contentText, type MutableModels } from "@earendil-works/pi-ai";
import type { LibraryFacts } from "../covault/skill";
import { explainAskError } from "./ask";
import { createTransportProbe, describeError, type DiagnoseFn, type TransportProbe } from "./transport";

const SYSTEM_PROMPT = `You describe knowledge libraries for a routing index used by AI assistants.

Given a library's name, folder structure and README, answer with ONE line (max ~25 words) describing what topics and questions this library covers. The line is used to decide when to consult the library.

Rules:
- Plain text only: no quotes, no markdown, no trailing period, no "This library".
- Lead with the concrete domain (product names, systems, teams), not generic words like "documentation" or "knowledge".
- Keep proper nouns exactly as written in the source material.`;

export function buildDescribePrompt(facts: LibraryFacts): string {
  const parts = [`Library name: ${facts.name}`, `Folder: ${facts.repo.path}`];
  if (facts.topEntries.length > 0) parts.push(`Structure: ${facts.topEntries.join(", ")}`);
  if (facts.readmeExcerpt) parts.push("", "README begins:", facts.readmeExcerpt);
  parts.push("", "Answer with the one-line description only.");
  return parts.join("\n");
}

/** Whatever the model says, the manifest stores one clean line. */
export function sanitizeDescription(raw: string): string {
  const line = raw
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0]
    ?.replace(/^["'“”]+|["'“”.]+$/g, "")
    .trim();
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export interface DescriberDeps {
  models: MutableModels;
  getSelection: () => { provider: string; model: string };
  hasKey: (provider: string) => boolean;
  /** One line per model HTTP request, for the debug log (see transport.ts). */
  onTransport?: (line: string, failed: boolean) => void;
  /** Second look at a failed request, outside the renderer's CORS rules. */
  diagnose?: DiagnoseFn;
}

export class LibraryDescriber {
  /** Same instrumented HTTP layer as Ask, so a failure here leaves a
   *  debug-log line and a cause instead of a silent empty description. */
  private probe: TransportProbe;

  constructor(private deps: DescriberDeps) {
    this.probe = createTransportProbe(
      (line, failed) => this.deps.onTransport?.(line, failed),
      undefined,
      (url) => this.deps.diagnose?.(url) ?? Promise.resolve(null),
    );
  }

  isEnabled(): boolean {
    const { provider, model } = this.deps.getSelection();
    return !!provider && !!model && this.deps.hasKey(provider);
  }

  /** One line, or null when no model is configured / the reply was empty. */
  async describe(facts: LibraryFacts): Promise<string | null> {
    if (!this.isEnabled()) return null;
    const { provider, model: modelId } = this.deps.getSelection();
    const model = this.deps.models.getModel(provider, modelId);
    if (!model) return null;

    this.probe.reset();
    let reply;
    try {
      reply = await this.deps.models.completeSimple(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildDescribePrompt(facts), timestamp: Date.now() }],
        },
        { fetch: this.probe.fetch },
      );
    } catch (e) {
      throw new Error(explainAskError(describeError(e), this.probe.lastFailure));
    }
    const line = sanitizeDescription(contentText(reply.content));
    return line || null;
  }
}
