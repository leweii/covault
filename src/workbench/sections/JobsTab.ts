/**
 * The Jobs tab: every automation with its state, when it runs next, an
 * expandable run log, and an inline editor for its name, schedule and
 * instructions. Setting a job up from nothing stays in Automations (by
 * chat); the editor is for the adjustments that follow.
 */
import { MarkdownRenderer, Notice, TFile, setIcon, type Component } from "obsidian";
import type { Automation, RunLog } from "../../automation/store";
import { describeSchedule, parseSchedule, type Schedule } from "../../automation/schedule";
import { ConfirmModal } from "../../ui/ConfirmModal";
import type { JobDraft, WorkbenchContext } from "./context";
import { button, countdown, dateTime, relative } from "./util";

export function renderJobs(ctx: WorkbenchContext, el: HTMLElement, owner: Component): void {
  el.empty();
  const { plugin } = ctx;
  const jobs = plugin.automations.list();
  if (jobs.length === 0) {
    el.createDiv({ cls: "covault-wb-empty", text: "No jobs yet." });
  }
  for (const job of jobs) renderJob(ctx, el, job, owner);
  const foot = el.createDiv("covault-wb-jobs-foot");
  foot.appendText("Jobs are set up by chat in the Automations tab — ");
  const link = foot.createEl("a", { text: "open Automations" });
  link.onclick = () => void plugin.activateAutomationView();
  foot.appendText(".");
}

function renderJob(ctx: WorkbenchContext, parent: HTMLElement, job: Automation, owner: Component): void {
  const { plugin, state } = ctx;
  const runner = plugin.automationRunner;
  const runs = plugin.automations.runs(job.id);
  const last = runs[0];
  const running = runner.isRunning(job.id);
  const open = state.expandedJobs.has(job.id);
  const card = parent.createDiv(`covault-wb-job ${job.enabled ? "" : "is-paused"}`);
  const head = card.createDiv("covault-wb-job-head");
  setIcon(head.createSpan("covault-wb-log-chev"), open ? "chevron-down" : "chevron-right");
  setIcon(head.createSpan("covault-wb-job-icon"), "bot");
  const info = head.createDiv("covault-wb-job-info");
  info.createDiv({ cls: "covault-wb-job-name", text: job.name });
  info.createDiv({
    cls: "is-muted",
    text: `${describeSchedule(job.schedule)}${job.enabled ? "" : " · paused"} · ${last ? `last ${relative(last.at)}` : "never run"}`,
  });
  head.createSpan({
    cls: `covault-wb-tag is-${running ? "run" : last?.status === "error" ? "err" : last ? "ok" : ""}`,
    text: running ? "Running" : last?.status === "error" ? "Last run failed" : last ? "Last run OK" : "Not run yet",
  });
  const next = runner.nextRunAt(job);
  const nextEl = head.createDiv("covault-wb-job-next");
  nextEl.createSpan({ cls: "is-muted", text: next ? "next in" : "" });
  nextEl.createEl("b", { text: next ? countdown(next) : "paused", attr: { "data-until": next ? String(next) : "" } });
  const editing = state.editingJob === job.id;
  button(head, {
    icon: "pencil",
    cls: `covault-wb-icon-btn ${editing ? "is-on" : ""}`,
    title: editing ? "Close the editor" : "Edit",
    onClick: () => {
      if (editing) {
        state.editingJob = null;
        state.jobDraft = null;
      } else {
        state.editingJob = job.id;
        state.jobDraft = { name: job.name, instructions: job.instructions, schedule: { ...job.schedule }, enabled: job.enabled };
      }
      ctx.refresh("jobs");
    },
  });
  button(head, {
    icon: running ? "loader" : "play",
    cls: "covault-wb-icon-btn",
    title: "Run now",
    disabled: running,
    onClick: () => {
      void runner.runNow(job.id, "manual");
      new Notice(`Covault: started “${job.name}”.`);
    },
  });
  head.onclick = () => {
    if (open) state.expandedJobs.delete(job.id);
    else state.expandedJobs.add(job.id);
    ctx.refresh("jobs");
  };
  if (editing && state.jobDraft) {
    renderEditor(ctx, card.createDiv("covault-wb-jedit"), job, state.jobDraft);
    return;
  }
  if (!open) return;

  const body = card.createDiv("covault-wb-job-body");
  const instr = body.createEl("details", { cls: "covault-wb-job-instr" });
  instr.createEl("summary", { text: "Instructions" });
  instr.createEl("pre", { text: job.instructions });
  if (runs.length === 0) {
    body.createDiv({ cls: "covault-wb-empty", text: running ? "First run in progress…" : "No runs yet." });
    return;
  }
  for (const r of runs) renderRun(ctx, body, job, r, owner);
}

function renderRun(ctx: WorkbenchContext, parent: HTMLElement, job: Automation, r: RunLog, owner: Component): void {
  const key = `${job.id}:${r.at}`;
  const open = ctx.state.expandedRuns.has(key);
  const run = parent.createDiv("covault-wb-run");
  const line = run.createDiv("covault-wb-run-line");
  line.createSpan({
    cls: `covault-wb-tag is-${r.status === "ok" ? "ok" : r.status === "error" ? "err" : "skip"}`,
    text: r.status === "ok" ? "Done" : r.status === "error" ? "Failed" : "Skipped",
  });
  line.createSpan({ cls: "is-muted", text: dateTime(r.at) });
  line.createSpan({ cls: "covault-wb-tag", text: r.trigger === "manual" ? "run by hand" : "scheduled" });
  const bits = [];
  if (r.status !== "skipped") bits.push(`${Math.round(r.ms / 1000)}s`);
  if (r.changed.length) bits.push(`${r.changed.length} note(s) changed`);
  line.createSpan({ cls: "is-faint", text: bits.join(" · ") });
  line.onclick = () => {
    if (open) ctx.state.expandedRuns.delete(key);
    else ctx.state.expandedRuns.add(key);
    ctx.refresh("jobs");
  };
  if (!open) return;

  const detail = run.createDiv("covault-wb-run-detail");
  const report = detail.createDiv("covault-wb-run-report markdown-rendered");
  void MarkdownRenderer.render(ctx.app, r.summary, report, "", owner);
  if (r.changed.length) {
    const changed = detail.createDiv("covault-wb-run-changed");
    for (const p of r.changed) {
      const a = changed.createEl("a", { cls: "covault-wb-flink", text: p });
      a.onclick = () => {
        const file = ctx.app.vault.getAbstractFileByPath(p);
        if (file instanceof TFile) void ctx.app.workspace.getLeaf(false).openFile(file);
        else new Notice(`Covault: ${p} no longer exists.`);
      };
    }
  }
  if (r.tools.length) {
    const steps = detail.createEl("details", { cls: "covault-wb-run-steps" });
    steps.createEl("summary", { text: `${r.tools.length} step(s)` });
    const ul = steps.createEl("ul");
    for (const t of r.tools) ul.createEl("li", { text: `${t.name}${t.summary ? ` — ${t.summary}` : ""}${t.isError ? " (failed)" : ""}` });
  }
}

/**
 * The inline editor. Fields write straight into the draft, so a re-render
 * (switching the schedule kind) rebuilds the form without losing input.
 * Save validates the schedule the same way the chat does, and a changed
 * schedule — or resuming — counts from now, never replaying old slots.
 */
function renderEditor(ctx: WorkbenchContext, el: HTMLElement, job: Automation, draft: JobDraft): void {
  const { plugin, state } = ctx;
  el.empty();
  const field = (label: string): HTMLElement => {
    const wrap = el.createDiv("covault-wb-jedit-field");
    wrap.createDiv({ cls: "covault-wb-jedit-label", text: label });
    return wrap;
  };
  const nameEl = field("Name").createEl("input", { attr: { type: "text", value: draft.name } });
  nameEl.oninput = () => (draft.name = nameEl.value);

  const runs = field("Runs").createDiv("covault-wb-jedit-sched");
  const seg = runs.createDiv("covault-wb-seg");
  const kind = (k: Schedule["kind"], label: string) => {
    const b = seg.createEl("button", { cls: draft.schedule.kind === k ? "is-on" : "", text: label });
    b.onclick = () => {
      draft.schedule =
        k === "interval"
          ? { kind: "interval", hours: draft.schedule.kind === "interval" ? draft.schedule.hours : 6 }
          : { kind: "daily", hour: draft.schedule.kind === "daily" ? draft.schedule.hour : 9, minute: draft.schedule.kind === "daily" ? draft.schedule.minute : 0 };
      renderEditor(ctx, el, job, draft);
    };
  };
  kind("interval", "Every N hours");
  kind("daily", "Every day at");
  if (draft.schedule.kind === "interval") {
    runs.appendText("every ");
    const hours = runs.createEl("input", { attr: { type: "number", min: "1", max: "168", value: String(draft.schedule.hours) } });
    hours.oninput = () => {
      if (draft.schedule.kind === "interval") draft.schedule.hours = Number(hours.value);
    };
    runs.appendText(" hours");
  } else {
    const p = (n: number) => String(n).padStart(2, "0");
    runs.appendText("at ");
    const time = runs.createEl("input", { attr: { type: "time", value: `${p(draft.schedule.hour)}:${p(draft.schedule.minute)}` } });
    time.oninput = () => {
      const [h, m] = time.value.split(":").map(Number);
      if (draft.schedule.kind === "daily" && Number.isFinite(h) && Number.isFinite(m)) {
        draft.schedule.hour = h!;
        draft.schedule.minute = m!;
      }
    };
  }
  const enabled = runs.createEl("label", { cls: "covault-wb-jedit-enabled" });
  const box = enabled.createEl("input", { attr: { type: "checkbox" } });
  box.checked = draft.enabled;
  box.onchange = () => (draft.enabled = box.checked);
  enabled.appendText(" Enabled");

  const instr = field("Instructions for the agent").createEl("textarea", { attr: { rows: "5", spellcheck: "false" } });
  instr.value = draft.instructions;
  instr.oninput = () => (draft.instructions = instr.value);

  const foot = el.createDiv("covault-wb-jedit-foot");
  const hint = foot.createSpan({ cls: "is-muted covault-wb-jedit-hint" });
  hint.appendText("Want help rewording it? ");
  const refine = hint.createEl("a", { text: "Refine it by chat in Automations" });
  refine.onclick = () => void plugin.activateAutomationView();
  const done = () => {
    state.editingJob = null;
    state.jobDraft = null;
    plugin.refreshAutomationViews(); // both tabs, and the counters
    ctx.refresh("state");
  };
  button(foot, {
    text: "Delete",
    cls: "covault-wb-btn-sm covault-wb-btn-danger-text",
    onClick: async () => {
      const ok = await ConfirmModal.ask(ctx.app, {
        title: "Delete automation",
        message: `Delete "${job.name}" and its run log? Notes it already wrote stay.`,
        cta: "Delete",
      });
      if (!ok) return;
      plugin.automations.remove(job.id);
      done();
    },
  });
  button(foot, {
    text: "Cancel",
    cls: "covault-wb-btn-sm",
    onClick: () => {
      state.editingJob = null;
      state.jobDraft = null;
      ctx.refresh("jobs");
    },
  });
  button(foot, {
    text: "Save",
    cls: "covault-wb-btn-sm mod-cta",
    onClick: () => {
      const name = draft.name.trim();
      if (!name) {
        new Notice("Covault: the job needs a name.");
        return;
      }
      let schedule: Schedule;
      try {
        schedule = parseSchedule(draft.schedule);
      } catch (e) {
        new Notice(`Covault: ${(e as Error).message}`);
        return;
      }
      const scheduleChanged = JSON.stringify(schedule) !== JSON.stringify(job.schedule);
      const resumed = draft.enabled && !job.enabled;
      plugin.automations.update(job.id, {
        name,
        instructions: draft.instructions.trim(),
        schedule,
        enabled: draft.enabled,
        ...(scheduleChanged || resumed ? { lastSlotAt: Date.now() } : {}),
      });
      new Notice(`Covault: saved “${name}”.`);
      done();
    },
  });
}

/** Once a second: the "next in" cells only. */
export function tickJobs(el: HTMLElement): void {
  for (const cell of Array.from(el.querySelectorAll<HTMLElement>("[data-until]"))) {
    const at = Number(cell.dataset.until);
    if (at) cell.setText(countdown(at));
  }
}
