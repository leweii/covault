/**
 * The Jobs tab: every automation with its state, when it runs next, and
 * an expandable run log — the same facts the Automations tab shows, here
 * next to the sync log. Setting jobs up stays in Automations (by chat);
 * editing in place arrives with phase 4.
 */
import { MarkdownRenderer, Notice, TFile, setIcon, type Component } from "obsidian";
import type { Automation, RunLog } from "../../automation/store";
import { describeSchedule } from "../../automation/schedule";
import type { WorkbenchContext } from "./context";
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

/** Once a second: the "next in" cells only. */
export function tickJobs(el: HTMLElement): void {
  for (const cell of Array.from(el.querySelectorAll<HTMLElement>("[data-until]"))) {
    const at = Number(cell.dataset.until);
    if (at) cell.setText(countdown(at));
  }
}
