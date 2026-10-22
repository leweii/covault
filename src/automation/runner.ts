/**
 * Runs automations: a 30-second tick decides what is due, and due jobs
 * run one at a time as unattended agents with the note tools.
 *
 * Due-ness is slot-based. Each automation remembers the last slot it
 * dealt with (lastSlotAt); a tick looks for a newer slot at or before
 * now. Within LATE_GRACE_MS of it the job runs; later than that the
 * machine slept or Obsidian was closed through it, and the slot is
 * logged as skipped instead — missed runs are never caught up.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ManifestRepo } from "../covault/manifest";
import { buildAgent, finalText, modelReady, runError, type ModelDeps } from "./agent";
import { makeNoteTools, type NoteToolDeps } from "./noteTools";
import { LATE_GRACE_MS, latestSlotAtOrBefore, nextRunAfter } from "./schedule";
import type { Automation, AutomationStore, RunLog, ToolCallLog } from "./store";

export interface RunnerDeps {
  store: AutomationStore;
  model: ModelDeps;
  notes: NoteToolDeps;
  repos: () => ManifestRepo[];
  vaultName: () => string;
  /** A run wrote notes — kick the sync loop so they're committed and shared. */
  onNotesChanged: () => void;
  /** Something the Automations view shows changed (status, log, schedule). */
  onChange: () => void;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const MAX_TURNS = 30;
const RUN_TIMEOUT_MS = 10 * 60_000;
const MAX_SUMMARY_CHARS = 6_000;

const JOB_SYSTEM_PROMPT = `You are running a scheduled automation inside the user's Obsidian vault. You run unattended: nobody will answer questions or approve anything during the run, so never ask — decide, or skip what you can't do and say so.

Work only through the tools. Notes are Markdown; paths are vault-relative. Folders listed as team knowledge libraries are shared with the user's teammates — changes there reach them on the next sync, so edit them carefully and only as the task requires.

Rules:
- Do exactly what the automation's instructions ask, nothing more.
- Read before you write: check what already exists so you don't duplicate or clobber it.
- Never invent facts. If the information isn't in the vault, say so instead of guessing.
- Write in the language the instructions are written in, unless they say otherwise.

When you are done, reply with a short report for the run log: what you did, which notes you created or changed (paths), and anything that needs the user's attention.`;

function argSummary(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["path", "query", "library"]) {
    if (typeof a[key] === "string" && a[key]) parts.push(String(a[key]));
  }
  if (Array.isArray(a.edits)) parts.push(`${a.edits.length} edit(s)`);
  return parts.join(" · ").slice(0, 200);
}

export class AutomationRunner {
  private running = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private deps: RunnerDeps) {}

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** When the next scheduled run is due, or null when disabled. */
  nextRunAt(a: Automation, now = Date.now()): number | null {
    if (!a.enabled) return null;
    return nextRunAfter(a.schedule, now, a.lastSlotAt ?? a.createdAt);
  }

  stop(): void {
    this.stopped = true;
  }

  /** One scheduler pass; call every 30 s. */
  tick(now = Date.now()): void {
    if (this.stopped) return;
    for (const a of this.deps.store.list()) {
      if (!a.enabled || this.running.has(a.id)) continue;
      const handled = a.lastSlotAt ?? a.createdAt;
      const slot = latestSlotAtOrBefore(a.schedule, now, handled);
      if (slot === null || slot <= handled) continue;
      this.deps.store.update(a.id, { lastSlotAt: slot });
      if (now - slot <= LATE_GRACE_MS) {
        void this.runNow(a.id, "schedule");
      } else {
        this.deps.store.appendRun(a.id, {
          at: now,
          status: "skipped",
          trigger: "schedule",
          ms: 0,
          summary: `Skipped the ${new Date(slot).toLocaleString()} run — Obsidian wasn't open (or the computer was asleep) at that time.`,
          tools: [],
          changed: [],
        });
        this.deps.onChange();
      }
    }
  }

  /**
   * Queue a run. Jobs run one at a time: they share one model key and its
   * rate limits, and two agents editing the same vault at once is a race.
   */
  runNow(id: string, trigger: RunLog["trigger"] = "manual"): Promise<void> {
    if (this.running.has(id)) return Promise.resolve();
    this.running.add(id);
    this.deps.onChange();
    const run = this.queue.then(() => this.execute(id, trigger)).finally(() => {
      this.running.delete(id);
      this.deps.onChange();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async execute(id: string, trigger: RunLog["trigger"]): Promise<void> {
    const automation = this.deps.store.get(id);
    if (!automation || this.stopped) return;
    const startedAt = Date.now();
    const tools: ToolCallLog[] = [];
    const changed = new Set<string>();
    const finish = (status: RunLog["status"], summary: string) => {
      const run: RunLog = {
        at: Date.now(),
        status,
        trigger,
        ms: Date.now() - startedAt,
        summary: summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary,
        tools,
        changed: [...changed],
      };
      // Deleted while it ran: its log went with it, don't resurrect one.
      if (this.deps.store.get(id)) {
        this.deps.store.appendRun(id, run);
        this.deps.store.update(id, { lastRunAt: startedAt });
      }
      this.deps.log?.(`automation "${automation.name}" — ${status}`, { ms: run.ms, tools: tools.length, changed: run.changed.length });
      if (changed.size > 0) this.deps.onNotesChanged();
    };

    if (!modelReady(this.deps.model)) {
      finish("error", "No AI model is set up — choose a provider, model and API key in Settings → Covault → AI engine.");
      return;
    }

    let built;
    try {
      const noteTools: AgentTool[] = makeNoteTools(this.deps.notes, (p) => changed.add(p));
      built = buildAgent(this.deps.model, { systemPrompt: JOB_SYSTEM_PROMPT, tools: noteTools, maxTurns: MAX_TURNS });
    } catch (e) {
      finish("error", (e as Error).message);
      return;
    }
    const { agent } = built;
    const pending = new Map<string, ToolCallLog>();
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        pending.set(event.toolCallId, { name: event.toolName, summary: argSummary(event.args), isError: false });
      } else if (event.type === "tool_execution_end") {
        const entry = pending.get(event.toolCallId) ?? { name: event.toolName, summary: "", isError: false };
        entry.isError = event.isError;
        tools.push(entry);
        pending.delete(event.toolCallId);
      }
    });

    const timer = window.setTimeout(() => agent.abort(), RUN_TIMEOUT_MS);
    try {
      await agent.prompt(this.jobPrompt(automation));
      const error = runError(built);
      const report = finalText(agent);
      if (error) finish("error", report ? `${error}\n\n${report}` : error);
      else if (built.turns() >= MAX_TURNS && !report) finish("error", `Stopped after ${MAX_TURNS} steps without finishing.`);
      else finish("ok", report || "(finished without a report)");
    } catch (e) {
      finish("error", runError(built, e) ?? (e instanceof Error ? e.message : "The run failed."));
    } finally {
      window.clearTimeout(timer);
    }
  }

  private jobPrompt(a: Automation): string {
    const libraries = this.deps.repos().map((r) => `- ${r.path}/${r.description ? ` — ${r.description}` : ""}`);
    return [
      `Automation: ${a.name}`,
      `Now: ${new Date().toString()}`,
      `Vault: ${this.deps.vaultName()}`,
      libraries.length > 0 ? `Team knowledge libraries in this vault:\n${libraries.join("\n")}` : "No team libraries in this vault.",
      "",
      "Instructions:",
      a.instructions,
    ].join("\n");
  }
}
