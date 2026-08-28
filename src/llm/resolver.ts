/**
 * AI conflict resolution on pi-ai. Ports agentic-git-sync's prompt and
 * response contract; the transport is the plugin's Models registry
 * (provider/model/key from settings) instead of hand-rolled providers.
 */
import { contentText, type MutableModels } from "@earendil-works/pi-ai";
import { explainAskError } from "./ask";
import { createTransportProbe, describeError, type DiagnoseFn, type TransportProbe } from "./transport";

export interface AISuggestionRequest {
  filePath?: string;
  hunk: { local: string[]; remote: string[] };
  context?: { before: string[]; after: string[] };
}

export interface AISuggestion {
  merged: string[];
  reasoning: string[];
  /** 0–5; ≥ silent threshold means safe to apply without asking. */
  confidence: number;
  /** Indices into merged[] where the model made a substantive choice. */
  picks: number[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AISuggestResult {
  suggestion: AISuggestion;
  providerName: string;
}

export const SYSTEM_PROMPT = `You resolve git merge conflicts in user notes and text files.

You receive two versions of a text fragment that conflict (Local + Remote). Output one merged version that preserves intent from both sides where possible.

Output STRICT JSON only — no markdown, no commentary, no code fences:
{
  "merged": ["line 1", "line 2", "..."],
  "reasoning": ["short bullet 1", "short bullet 2"],
  "confidence": 3,
  "picks": [0, 2]
}

Field rules:
- "merged": resulting hunk as array of lines. Match the input style/indentation. Never include conflict markers (<<<<<<<, =======, >>>>>>>).
- "reasoning": 1 to 4 concise bullets explaining the choice. Each bullet ≤ 20 words.
- "confidence": integer 0-5. 0 = no clue / contradictory; 5 = obvious merge.
- "picks": indices into the "merged" array marking lines where you made a substantive choice between Local and Remote (these get ★ in the UI). Skip context lines and common lines.

Resolution heuristics:
- Complementary additions (each side added different new things) → include both.
- Same content, different formatting → keep one consistent format.
- One side empty → take the non-empty side.

When to give up (IMPORTANT):
- Contradictory facts (different dates, numbers, opposite claims) that cannot both be true, with no clear evidence in the text of which is correct → do NOT guess. Set "confidence" to 0 or 1, put the Local side in "merged" unchanged, and state in "reasoning" that a human must decide because the two versions contradict each other.
- Any merge you are not sure preserves BOTH sides' intent → lower the confidence. Suggestions with confidence 3 or higher are applied automatically without human review, so only use 3+ when the merge is safe beyond doubt.
`;

export function buildPrompt(req: AISuggestionRequest): string {
  const parts: string[] = [];
  if (req.filePath) parts.push(`File: ${req.filePath}`);
  parts.push("");

  if (req.context?.before?.length) {
    parts.push("=== Context before ===", req.context.before.join("\n"), "");
  }
  parts.push("=== Local (your version) ===");
  parts.push(req.hunk.local.length ? req.hunk.local.join("\n") : "(empty)");
  parts.push("");
  parts.push("=== Remote (incoming version) ===");
  parts.push(req.hunk.remote.length ? req.hunk.remote.join("\n") : "(empty)");
  if (req.context?.after?.length) {
    parts.push("", "=== Context after ===", req.context.after.join("\n"));
  }
  parts.push("", "Resolve the conflict. Return JSON only.");
  return parts.join("\n");
}

export function parseAIResponse(content: string): Pick<AISuggestion, "merged" | "reasoning" | "confidence" | "picks"> {
  let cleaned = content.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`AI response was not valid JSON: ${(e as Error).message}`);
  }

  // Never trust the LLM to return well-typed fields — coerce + clamp at
  // the boundary, then downstream code sees a fully-typed suggestion.
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;

  const merged: string[] = Array.isArray(obj.merged)
    ? obj.merged.map(stringifyItem)
    : typeof obj.merged === "string"
      ? obj.merged.split("\n")
      : [];
  const reasoning: string[] = Array.isArray(obj.reasoning)
    ? obj.reasoning.map(stringifyItem)
    : typeof obj.reasoning === "string"
      ? [obj.reasoning]
      : [];
  const confidence = Math.min(5, Math.max(0, Number(obj.confidence) || 0));
  const picks: number[] = Array.isArray(obj.picks)
    ? obj.picks.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < merged.length)
    : [];

  return { merged, reasoning, confidence, picks };
}

function stringifyItem(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

export interface ResolverDeps {
  models: MutableModels;
  getSelection: () => { provider: string; model: string };
  hasKey: (provider: string) => boolean;
  /** One line per model HTTP request, for the debug log (see transport.ts). */
  onTransport?: (line: string, failed: boolean) => void;
  /** Second look at a failed request, outside the renderer's CORS rules. */
  diagnose?: DiagnoseFn;
}

export class ConflictResolver {
  /** Same instrumented HTTP layer as Ask — without it a connection failure
   *  here surfaces as the SDK's bare "Connection error.", which the
   *  ConflictModal shows the user verbatim. */
  private probe: TransportProbe;

  constructor(private deps: ResolverDeps) {
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

  async suggest(req: AISuggestionRequest): Promise<AISuggestResult> {
    const { provider, model: modelId } = this.deps.getSelection();
    const model = this.deps.models.getModel(provider, modelId);
    if (!model) throw new Error(`Model ${provider}/${modelId} is not available — pick one in Settings.`);

    this.probe.reset();
    let reply;
    try {
      reply = await this.deps.models.completeSimple(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildPrompt(req), timestamp: Date.now() }],
        },
        { fetch: this.probe.fetch },
      );
    } catch (e) {
      throw new Error(explainAskError(describeError(e), this.probe.lastFailure));
    }

    const parsed = parseAIResponse(contentText(reply.content));
    const usage = reply.usage;
    return {
      providerName: provider,
      suggestion: {
        ...parsed,
        model: modelId,
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        costUsd: usage?.cost?.total ?? 0,
      },
    };
  }
}
