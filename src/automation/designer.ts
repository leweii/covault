/**
 * The setup conversation: the user describes what they want automated,
 * and this agent turns it into automations through tools — create,
 * change, pause, delete, try now — reading the vault where that helps it
 * write good instructions (which folder, what the notes look like).
 *
 * It is told to confirm in the chat before it creates, changes or
 * deletes anything; the Automations list beside the chat shows every
 * result immediately, and everything stays editable by hand.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildAgent, finalText, runError, type BuiltAgent, type ModelDeps } from "./agent";
import { makeNoteTools, type NoteToolDeps } from "./noteTools";
import type { AutomationRunner } from "./runner";
import { describeSchedule, parseSchedule } from "./schedule";
import type { Automation, AutomationStore } from "./store";

export interface DesignerDeps {
  store: AutomationStore;
  runner: AutomationRunner;
  model: ModelDeps;
  notes: NoteToolDeps;
  vaultName: () => string;
  onChange: () => void;
}

export interface DesignerCallbacks {
  /** Streaming text of the answer being written. */
  onText?: (partial: string) => void;
  /** A tool started — a short status line for the chat. */
  onActivity?: (line: string) => void;
}

const MAX_TURNS = 20;

const SYSTEM_PROMPT = `You help the user set up automations for their Obsidian vault: tasks an AI agent runs on a schedule, unattended, with tools to search, read, create and edit notes anywhere in the vault (including the team knowledge libraries, which sync to teammates).

Supported schedules — only these two:
- every N hours (whole hours, 1–168): {"kind": "interval", "hours": N}
- every day at a local time: {"kind": "daily", "hour": 0–23, "minute": 0–59}
Automations run only while Obsidian is open on this computer; a run missed while it was closed is skipped, not caught up. If the user asks for something else (weekly, weekdays only, every 30 minutes), say it isn't supported and offer the closest option.

How to work:
1. Understand the task: what to read, what to produce, where to write it, in what format. Ask a short question when something important is unclear — but don't interrogate; propose sensible defaults.
2. Use the note tools to look at the vault when it helps (folder names, existing notes, formats).
3. Write the automation's instructions as a self-contained brief for a future agent that has never seen this conversation: concrete paths, what "done" looks like, how to avoid duplicates (e.g. a dated note name), what to do when there's nothing new.
4. Before creating, changing or deleting an automation, show the user the plan — name, schedule, and the instructions — and wait for their go-ahead in the chat. Then call the tool.
5. After creating one, offer to run it once now to check the result.

Reply in the user's language. Keep replies short.`;

/** A string argument from the model, or "" — never "[object Object]". */
function str(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

const ScheduleParam = Type.Object(
  {
    kind: Type.Union([Type.Literal("interval"), Type.Literal("daily")]),
    hours: Type.Optional(Type.Integer({ description: "For interval: run every this many hours (1–168)." })),
    hour: Type.Optional(Type.Integer({ description: "For daily: hour of day, 0–23, local time." })),
    minute: Type.Optional(Type.Integer({ description: "For daily: minute, 0–59. Default 0." })),
  },
  { description: "When it runs." },
);

function render(a: Automation, runner: AutomationRunner): string {
  const next = runner.nextRunAt(a);
  return [
    `id: ${a.id}`,
    `name: ${a.name}`,
    `schedule: ${describeSchedule(a.schedule)}${a.enabled ? "" : " (paused)"}`,
    next ? `next run: ${new Date(next).toLocaleString()}` : "",
    a.lastRunAt ? `last run: ${new Date(a.lastRunAt).toLocaleString()}` : "never run yet",
    `instructions:\n${a.instructions}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export class AutomationDesigner {
  private built: BuiltAgent | null = null;
  private busy = false;

  constructor(private deps: DesignerDeps) {}

  isBusy(): boolean {
    return this.busy;
  }

  /** Forget the conversation; the next message starts fresh. */
  reset(): void {
    this.built?.agent.abort();
    this.built = null;
  }

  abort(): void {
    this.built?.agent.abort();
  }

  private tools(): AgentTool[] {
    const { store, runner } = this.deps;
    const changed = () => this.deps.onChange();
    const find = (id: unknown): Automation => {
      const a = store.get(str(id));
      if (!a) throw new Error(`No automation with id "${str(id)}" — call list_automations for the ids.`);
      return a;
    };

    const list: AgentTool = {
      name: "list_automations",
      label: "List automations",
      description: "List the automations set up in this vault, with their ids, schedules and instructions.",
      parameters: Type.Object({}),
      execute: async () => {
        const all = store.list();
        return text(all.length > 0 ? all.map((a) => render(a, runner)).join("\n\n---\n\n") : "No automations yet.");
      },
    };

    const create: AgentTool = {
      name: "create_automation",
      label: "Create automation",
      description: "Create a new automation. Only after the user has agreed to the plan in the chat.",
      parameters: Type.Object({
        name: Type.String({ description: "Short name shown in the list." }),
        instructions: Type.String({ description: "Self-contained brief for the unattended agent." }),
        schedule: ScheduleParam,
      }),
      execute: async (_id, params) => {
        const p = params as { name: string; instructions: string; schedule: unknown };
        if (!p.name?.trim() || !p.instructions?.trim()) throw new Error("name and instructions are required.");
        const a = store.add({ name: p.name, instructions: p.instructions, schedule: parseSchedule(p.schedule) });
        changed();
        return text(`Created.\n${render(a, runner)}`);
      },
    };

    const update: AgentTool = {
      name: "update_automation",
      label: "Update automation",
      description:
        "Change an automation's name, instructions or schedule, or pause/resume it (enabled). Only after the user agreed. Omitted fields stay as they are.",
      parameters: Type.Object({
        id: Type.String(),
        name: Type.Optional(Type.String()),
        instructions: Type.Optional(Type.String()),
        schedule: Type.Optional(ScheduleParam),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => {
        const p = params as { id: string; name?: string; instructions?: string; schedule?: unknown; enabled?: boolean };
        const current = find(p.id);
        const patch: Partial<Automation> = {};
        if (p.name !== undefined) patch.name = p.name.trim();
        if (p.instructions !== undefined) patch.instructions = p.instructions.trim();
        if (p.schedule !== undefined) patch.schedule = parseSchedule(p.schedule);
        if (p.enabled !== undefined) patch.enabled = p.enabled;
        // A new schedule or a resume starts counting from now — no
        // replaying slots from before the change.
        if (patch.schedule || (patch.enabled && !current.enabled)) patch.lastSlotAt = Date.now();
        const a = store.update(current.id, patch);
        changed();
        return text(`Updated.\n${render(a, runner)}`);
      },
    };

    const remove: AgentTool = {
      name: "delete_automation",
      label: "Delete automation",
      description: "Delete an automation and its run log. Only after the user explicitly agreed.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params) => {
        const a = find((params as { id: string }).id);
        store.remove(a.id);
        changed();
        return text(`Deleted "${a.name}".`);
      },
    };

    const runNow: AgentTool = {
      name: "run_automation_now",
      label: "Run automation now",
      description:
        "Start one run of an automation right away, as a test. Returns immediately; the result appears in its run log (use recent_runs a little later).",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params) => {
        const a = find((params as { id: string }).id);
        void runner.runNow(a.id, "manual");
        return text(`Started "${a.name}". It may take a minute or two; the result will be in its run log.`);
      },
    };

    const recent: AgentTool = {
      name: "recent_runs",
      label: "Recent runs",
      description: "The last few runs of an automation: when, outcome, the agent's report, and which notes it changed.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params) => {
        const a = find((params as { id: string }).id);
        const running = runner.isRunning(a.id) ? "A run is in progress right now.\n\n" : "";
        const runs = store.runs(a.id).slice(0, 5);
        if (runs.length === 0) return text(`${running}No runs yet.`);
        return text(
          running +
            runs
              .map(
                (r) =>
                  `${new Date(r.at).toLocaleString()} — ${r.status} (${r.trigger}, ${(r.ms / 1000).toFixed(0)}s)` +
                  (r.changed.length ? `\nchanged: ${r.changed.join(", ")}` : "") +
                  `\n${r.summary}`,
              )
              .join("\n\n---\n\n"),
        );
      },
    };

    // Reading only: the designer looks at the vault, it never edits notes.
    const readOnly = makeNoteTools(this.deps.notes, () => undefined).filter((t) =>
      ["search_notes", "read_note", "list_folder"].includes(t.name),
    );
    return [list, create, update, remove, runNow, recent, ...readOnly];
  }

  /** Send one user message; resolves with the agent's reply. */
  async send(message: string, cb: DesignerCallbacks = {}): Promise<string> {
    if (this.busy) throw new Error("Still answering the previous message.");
    this.busy = true;
    try {
      if (!this.built) {
        this.built = buildAgent(this.deps.model, { systemPrompt: SYSTEM_PROMPT, tools: this.tools(), maxTurns: MAX_TURNS });
      }
      const built = this.built;
      built.probe.reset();
      const unsubscribe = built.agent.subscribe((event) => {
        if (event.type === "message_update" && (event.message as { role?: string }).role === "assistant") {
          const partial = (event.message as { content?: unknown }).content;
          if (Array.isArray(partial)) {
            cb.onText?.(
              partial
                .filter((c: { type?: string }) => c.type === "text")
                .map((c: { text?: string }) => c.text ?? "")
                .join(""),
            );
          }
        } else if (event.type === "tool_execution_start") {
          cb.onActivity?.(activityLine(event.toolName, event.args));
        }
      });
      try {
        const context = `[${new Date().toString()} · vault "${this.deps.vaultName()}"]\n`;
        await built.agent.prompt(context + message);
      } finally {
        unsubscribe();
      }
      const error = runError(built);
      if (error) throw new Error(error);
      return finalText(built.agent);
    } catch (e) {
      const built = this.built;
      throw new Error(built ? (runError(built, e) ?? describeUnknown(e)) : describeUnknown(e), { cause: e });
    } finally {
      this.busy = false;
    }
  }
}

function activityLine(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "search_notes":
      return `Searching notes for “${str(a.query)}”…`;
    case "read_note":
      return `Reading ${str(a.path)}…`;
    case "list_folder":
      return `Looking in ${str(a.path) || "the vault root"}…`;
    case "create_automation":
      return `Creating “${str(a.name)}”…`;
    case "update_automation":
      return "Updating the automation…";
    case "delete_automation":
      return "Deleting the automation…";
    case "run_automation_now":
      return "Starting a test run…";
    default:
      return "Working…";
  }
}

function describeUnknown(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : "Something went wrong.";
}
