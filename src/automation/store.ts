/**
 * Where automations and their run logs live: the per-device config
 * directory, never the vault. A synced vault would hand the same
 * automation to every machine that opens it, and each would run it —
 * three laptops writing the same daily digest three times.
 *
 *   <config>/covault/automations/<vaultKey>.json        definitions
 *   <config>/covault/automations/<vaultKey>/<id>.jsonl  run log, one line per run
 */
import * as path from "path";
import { parseSchedule, type Schedule } from "./schedule";

export interface Automation {
  id: string;
  name: string;
  /** Self-contained instructions for the unattended agent. */
  instructions: string;
  schedule: Schedule;
  enabled: boolean;
  createdAt: number;
  /** When it last actually ran (for display). */
  lastRunAt?: number;
  /**
   * The last schedule slot the scheduler dealt with — ran or skipped. Also
   * the anchor interval schedules count from. Reset to "now" whenever the
   * automation is enabled or rescheduled, so neither replays old slots.
   */
  lastSlotAt?: number;
}

export type RunStatus = "ok" | "error" | "skipped";

export interface ToolCallLog {
  name: string;
  /** One-line rendering of the arguments (paths, queries). */
  summary: string;
  isError: boolean;
}

export interface RunLog {
  at: number;
  status: RunStatus;
  trigger: "schedule" | "manual";
  ms: number;
  /** The agent's closing report, or why the run didn't happen. */
  summary: string;
  tools: ToolCallLog[];
  /** Notes the run wrote, vault-relative. */
  changed: string[];
}

export interface AutomationStoreDeps {
  fs: typeof import("fs");
  /** <config>/covault/automations */
  dir: () => string;
  /** Which vault — keys both the file and the log folder. */
  vaultKey: () => string;
}

/** Runs kept per automation; older lines are dropped on append. */
const MAX_RUNS_KEPT = 100;

export class AutomationStore {
  private cache: Automation[] | null = null;

  constructor(private deps: AutomationStoreDeps) {}

  private file(): string {
    return path.join(this.deps.dir(), `${this.deps.vaultKey()}.json`);
  }

  private logFile(id: string): string {
    return path.join(this.deps.dir(), this.deps.vaultKey(), `${id}.jsonl`);
  }

  list(): Automation[] {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(this.deps.fs.readFileSync(this.file(), "utf8")) as { automations?: unknown[] };
      this.cache = (raw.automations ?? []).flatMap((a) => {
        try {
          return [normalize(a)];
        } catch {
          return []; // one bad entry shouldn't take the rest down
        }
      });
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  get(id: string): Automation | undefined {
    return this.list().find((a) => a.id === id);
  }

  private save(list: Automation[]): void {
    this.cache = list;
    this.deps.fs.mkdirSync(this.deps.dir(), { recursive: true });
    this.deps.fs.writeFileSync(this.file(), JSON.stringify({ version: 1, automations: list }, null, 2));
  }

  add(fields: Pick<Automation, "name" | "instructions" | "schedule">): Automation {
    const automation: Automation = {
      id: newId(),
      name: fields.name.trim(),
      instructions: fields.instructions.trim(),
      schedule: fields.schedule,
      enabled: true,
      createdAt: Date.now(),
    };
    this.save([...this.list(), automation]);
    return automation;
  }

  update(id: string, patch: Partial<Omit<Automation, "id" | "createdAt">>): Automation {
    const current = this.get(id);
    if (!current) throw new Error(`No automation with id "${id}".`);
    const next = { ...current, ...patch };
    this.save(this.list().map((a) => (a.id === id ? next : a)));
    return next;
  }

  remove(id: string): void {
    this.save(this.list().filter((a) => a.id !== id));
    try {
      this.deps.fs.rmSync(this.logFile(id), { force: true });
    } catch {
      /* no log yet */
    }
  }

  appendRun(id: string, run: RunLog): void {
    const file = this.logFile(id);
    const { fs } = this.deps;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = this.readLines(file);
    lines.push(JSON.stringify(run));
    fs.writeFileSync(file, `${lines.slice(-MAX_RUNS_KEPT).join("\n")}\n`);
  }

  /** Newest first. */
  runs(id: string): RunLog[] {
    return this.readLines(this.logFile(id))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunLog];
        } catch {
          return [];
        }
      })
      .reverse();
  }

  private readLines(file: string): string[] {
    try {
      return this.deps.fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}

function newId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function normalize(raw: unknown): Automation {
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.instructions !== "string") {
    throw new Error("malformed automation");
  }
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions,
    schedule: parseSchedule(r.schedule),
    enabled: r.enabled !== false,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
    ...(typeof r.lastRunAt === "number" ? { lastRunAt: r.lastRunAt } : {}),
    ...(typeof r.lastSlotAt === "number" ? { lastSlotAt: r.lastSlotAt } : {}),
  };
}
