/**
 * The top of the workbench — the counters and the countdown to the next
 * automatic sync with "Sync now" — and its footer: the one-line status
 * ("Everything is shared", or what isn't) at the bottom right, the
 * overflow menu at the bottom left.
 *
 * While a sync runs the counters keep their cards and show a spinner in
 * place of the number — recounted when the round ends — and the footer
 * keeps naming the problems. Nothing here vanishes because work started.
 */
import { Menu, Notice, setIcon } from "obsidian";
import { RecommendedPluginsModal } from "../../ui/RecommendedPluginsModal";
import { repoOutcome } from "../model";
import type { WorkbenchContext } from "./context";
import { button, clock, countdown, relative } from "./util";

const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

export function renderHeader(ctx: WorkbenchContext, el: HTMLElement): void {
  el.empty();
  const { plugin, index } = ctx;
  const items = plugin.syncItems();
  const syncing = plugin.sync.isSweeping() || items.some((i) => plugin.sync.isSyncing(i.path));
  const counts = index.counts();
  const failed = items.filter((i) => repoOutcome(plugin.sync.state(i.path)) === "error");
  const jobs = plugin.automations.list();
  const running = jobs.filter((j) => plugin.automationRunner.isRunning(j.id)).length;
  const jobsFailed = jobs.filter((j) => plugin.automations.runs(j.id)[0]?.status === "error").length;

  // ── Counters ──
  const top = el.createDiv("covault-wb-top");
  const kpis = top.createDiv("covault-wb-kpis");
  const kpi = (tone: string, n: number | string, label: string, onClick: () => void, loading = syncing) => {
    // A div, not a <button>: Obsidian styles button.is-loading with its own
    // progress bar, and themes restyle buttons wholesale.
    const card = kpis.createDiv({ cls: `covault-wb-kpi is-${tone} ${loading ? "is-busy" : ""}`, attr: { role: "button", tabindex: "0" } });
    const num = card.createDiv("covault-wb-kpi-n");
    if (loading) setIcon(num.createSpan("covault-wb-spin"), "refresh-cw");
    else num.setText(String(n));
    card.createDiv({ cls: "covault-wb-kpi-l", text: label });
    card.setAttribute("aria-label", loading ? "Recounting after the sync…" : label);
    card.onclick = onClick;
    card.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") onClick();
    };
  };
  if (failed.length) kpi("red", failed.length, "Couldn't sync", () => ctx.scrollToFailures());
  kpi("red", counts.conflict, "Need your input", () => ctx.setFilter("conflict"));
  kpi("orange", counts.local, "Not shared yet", () => ctx.setFilter("local"));
  kpi("blue", counts.incoming, "New from teammates", () => ctx.setFilter("incoming"));
  const jobsLabel = [running && `${running} running`, jobsFailed && `${jobsFailed} failed`].filter(Boolean).join(" · ");
  kpi(jobsFailed ? "red" : "green", jobs.length, `Jobs${jobsLabel ? ` · ${jobsLabel}` : ""}`, () => ctx.showTab("jobs"), false);

  // ── Countdown + Sync now ──
  const right = top.createDiv("covault-wb-countdown");
  const ring = right.createDiv("covault-wb-ring");
  const svg = ring.createSvg("svg", { attr: { viewBox: "0 0 52 52" } });
  svg.createSvg("circle", { cls: "track", attr: { cx: "26", cy: "26", r: String(RING_R) } });
  svg.createSvg("circle", { cls: "prog", attr: { cx: "26", cy: "26", r: String(RING_R), "stroke-dasharray": String(RING_C) } });
  ring.createDiv("covault-wb-ring-text");
  const text = right.createDiv("covault-wb-cd-text");
  text.createDiv("covault-wb-cd-big");
  text.createDiv("covault-wb-cd-small");
  button(right, {
    text: syncing ? "Syncing…" : "Sync now",
    icon: "refresh-cw",
    cls: `mod-cta ${syncing ? "is-syncing" : ""}`,
    disabled: syncing,
    onClick: async () => {
      await plugin.sync.syncAll("manual");
      // A pass by hand starts the wait for the automatic one over.
      plugin.restartSyncCountdown();
      ctx.refresh("state");
    },
  });
  tickHeader(ctx, el);
}

/** The footer: the live status line left, the overflow menu right. */
export function renderFooter(ctx: WorkbenchContext, el: HTMLElement): void {
  el.empty();
  const { plugin, index } = ctx;
  const items = plugin.syncItems();
  const syncing = plugin.sync.isSweeping() || items.some((i) => plugin.sync.isSyncing(i.path));
  const counts = index.counts();
  const failed = items.filter((i) => repoOutcome(plugin.sync.state(i.path)) === "error").length;
  const status = el.createDiv("covault-wb-foot-status");
  const problems = [
    failed ? `${failed} ${failed === 1 ? "library" : "libraries"} couldn't sync` : "",
    counts.conflict ? `${counts.conflict} note(s) need your input` : "",
  ].filter(Boolean);
  const mood = failed ? "error" : counts.conflict ? "conflict" : "idle";
  status.createSpan({ cls: `covault-wb-foot-dot is-${syncing ? "syncing" : mood}` });
  status.createSpan({ text: [syncing ? "Syncing…" : "", ...problems].filter(Boolean).join(" · ") || "Everything is shared" });
  const more = el.createEl("button", { cls: "clickable-icon covault-wb-foot-more", attr: { "aria-label": "More" } });
  setIcon(more, "ellipsis");
  more.onclick = (e) => moreMenu(ctx).showAtMouseEvent(e);
}

/** Once a second: only the ring and its text, so the rest stays put. */
export function tickHeader(ctx: WorkbenchContext, el: HTMLElement): void {
  const { plugin } = ctx;
  const items = plugin.syncItems();
  const syncing = plugin.sync.isSweeping() || items.some((i) => plugin.sync.isSyncing(i.path));
  const ring = el.querySelector<HTMLElement>(".covault-wb-ring");
  const prog = el.querySelector<SVGCircleElement>(".covault-wb-ring circle.prog");
  const ringText = el.querySelector<HTMLElement>(".covault-wb-ring-text");
  const big = el.querySelector<HTMLElement>(".covault-wb-cd-big");
  const small = el.querySelector<HTMLElement>(".covault-wb-cd-small");
  if (!ring || !prog || !ringText || !big || !small) return;

  const last = Math.max(0, ...items.map((i) => plugin.sync.state(i.path).lastSyncedAt ?? 0));
  const lastText = last ? ` · last ${relative(last)}` : "";
  if (syncing) {
    ring.addClass("is-syncing");
    ringText.setText("");
    big.setText("Syncing now…");
    small.setText(`${items.length} ${items.length === 1 ? "library" : "libraries"}`);
    return;
  }
  ring.removeClass("is-syncing");
  const nextAt = plugin.nextAutoSyncAt();
  if (nextAt === null) {
    ring.addClass("is-off");
    prog.style.strokeDashoffset = String(RING_C);
    ringText.setText("off");
    big.setText("Automatic sync is off");
    small.setText(`Turn it on in Settings${lastText}`);
    return;
  }
  ring.removeClass("is-off");
  const interval = plugin.settings.sync.intervalMinutes * 60_000;
  const left = Math.max(0, nextAt - Date.now());
  prog.style.strokeDashoffset = String(RING_C * (1 - left / interval));
  ringText.setText(countdown(nextAt));
  big.setText(`Next sync in ${countdown(nextAt)}`);
  small.setText(`at ${clock(nextAt)} · every ${plugin.settings.sync.intervalMinutes} min${lastText}`);
}

/** Everything that used to be a toolbar button and isn't a section of its own. */
function moreMenu(ctx: WorkbenchContext): Menu {
  const { plugin, app } = ctx;
  const menu = new Menu();
  menu.addItem((i) => i.setTitle("Automations").setIcon("alarm-clock").onClick(() => void plugin.activateAutomationView()));
  menu.addItem((i) => i.setTitle("Recommended plugins").setIcon("puzzle").onClick(() => new RecommendedPluginsModal(app).open()));
  menu.addSeparator();
  menu.addItem((i) => i.setTitle("Export configuration (copy)").setIcon("upload").onClick(() => void plugin.exportConfiguration()));
  menu.addItem((i) =>
    i
      .setTitle("Copy sync-history file path")
      .setIcon("scroll-text")
      .onClick(() => {
        void navigator.clipboard.writeText(plugin.syncHistory.filePath());
        new Notice("Covault: path copied.");
      }),
  );
  menu.addSeparator();
  menu.addItem((i) => i.setTitle("Copy the diagnostic log").setIcon("clipboard-copy").onClick(() => void plugin.copyDebugLog()));
  menu.addItem((i) => i.setTitle("Clear the diagnostic log").setIcon("eraser").onClick(() => plugin.clearDebugLog()));
  return menu;
}
