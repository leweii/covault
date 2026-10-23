/**
 * The libraries block: collapsed, one row of name pills with the
 * problems first (no scrolling to find the one that's red); expanded, a
 * card per library with its state, last sync and badges. Expanding
 * pushes the rest of the page down — the page scrolls.
 */
import { setIcon } from "obsidian";
import { MainKbModal } from "../../ui/MainKbModal";
import { UpdatesModal } from "../../ui/UpdatesModal";
import type { SyncItem } from "../../sync/SyncController";
import { countStatuses, repoOutcome, repoRank, type StatusCounts } from "../model";
import type { WorkbenchContext } from "./context";
import { button, plural, relative, stateDot } from "./util";

export function renderLibraries(ctx: WorkbenchContext, el: HTMLElement): void {
  el.empty();
  const { plugin, state } = ctx;
  const items = plugin.syncItems();
  const visual = (item: SyncItem) => {
    const s = plugin.sync.state(item.path);
    return { outcome: repoOutcome(s), syncing: plugin.sync.isSyncing(item.path), state: s };
  };
  const ordered = [...items].sort((a, b) => repoRank(visual(a).outcome) - repoRank(visual(b).outcome));
  const failed = items.filter((i) => visual(i).outcome === "error").length;
  const conflicts = items.filter((i) => visual(i).outcome === "conflict").length;
  const last = Math.max(0, ...items.map((i) => plugin.sync.state(i.path).lastSyncedAt ?? 0));

  const head = el.createDiv("covault-wb-libs-head");
  head.createEl("h3", { text: "Libraries" });
  head.createSpan({ cls: "covault-wb-tag", text: String(items.length) });
  const sum = head.createSpan("covault-wb-libs-sum");
  if (failed) sum.createSpan({ cls: "is-red", text: `${failed} couldn't sync` });
  if (conflicts) sum.appendText(`${failed ? " · " : ""}${conflicts} need input`);
  if (last) sum.appendText(`${failed || conflicts ? " · " : ""}synced ${relative(last)}`);
  const toggle = head.createSpan({ cls: "covault-wb-libs-toggle", text: state.libsOpen ? "Collapse" : "Expand" });
  setIcon(toggle.createSpan(), state.libsOpen ? "chevron-down" : "chevron-right");
  head.onclick = () => {
    state.libsOpen = !state.libsOpen;
    plugin.app.saveLocalStorage("covault-wb-libs-open", state.libsOpen);
    ctx.refresh("state");
  };

  if (!plugin.settings.mainRepo) {
    // No personal KB: say so where the libraries are, with the way in.
    const note = el.createDiv("covault-wb-libs-note");
    note.appendText("Your own notes aren't backed up yet. ");
    const link = note.createEl("a", { text: "Connect a personal repo" });
    link.onclick = () => new MainKbModal(ctx.app, plugin).open();
  }

  if (items.length === 0) {
    el.createDiv({ cls: "covault-wb-empty", text: "No libraries yet — add one to pull your team's knowledge in." });
    return;
  }

  const badges = (parent: HTMLElement, counts: StatusCounts) => {
    const badge = (n: number, cls: string, title: string) => {
      if (!n) return;
      parent.createSpan({ cls: `covault-wb-badge is-${cls}`, text: String(n), attr: { "aria-label": title } });
    };
    badge(counts.conflict, "conflict", "Need your input");
    badge(counts.local, "local", "Not shared yet");
    badge(counts.incoming, "incoming", "New from teammates");
  };
  const countsOf = (item: SyncItem) => countStatuses(ctx.index.entriesFor(item.path).map((e) => e.status));
  const label = (item: SyncItem) => (item.path === "" ? "My knowledge base" : (item.label ?? item.path));
  const dotState = (item: SyncItem) => {
    const v = visual(item);
    return v.syncing ? "syncing" : v.outcome;
  };

  if (!state.libsOpen) {
    const strip = el.createDiv("covault-wb-libs-strip");
    const row = strip.createDiv("covault-wb-libs-row");
    for (const item of ordered) {
      const v = visual(item);
      const pill = row.createEl("button", { cls: `covault-wb-pill is-${v.outcome}`, attr: { "aria-label": label(item) } });
      stateDot(pill, dotState(item));
      pill.createSpan({ text: label(item) });
      badges(pill, countsOf(item));
      pill.onclick = () => ctx.showFile(item.path); // Phase 2: reveal in the tree
    }
    return;
  }

  const grid = el.createDiv("covault-wb-libs-grid");
  for (const item of ordered) {
    const v = visual(item);
    const card = grid.createDiv("covault-wb-lib-card");
    const row1 = card.createDiv("covault-wb-lib-row1");
    stateDot(row1, dotState(item));
    row1.createSpan({ cls: "covault-wb-lib-name", text: label(item), attr: { title: `${item.url} (${item.branch})` } });
    const unseen = plugin.sync.unseenUpdates(item.path);
    if (unseen) {
      const n = row1.createEl("button", { cls: "covault-wb-updates", text: `${unseen.files.size} new`, attr: { "aria-label": "Show what changed" } });
      n.onclick = (e) => {
        e.stopPropagation();
        new UpdatesModal(ctx.app, label(item), item.path, unseen).open();
        plugin.sync.markSeen(item.path);
        ctx.index.markedSeen(item.path);
      };
    }
    button(row1, {
      icon: "refresh-cw",
      cls: `covault-wb-icon-btn ${v.syncing ? "is-syncing" : ""}`,
      title: `Sync ${label(item)} now`,
      disabled: v.syncing,
      onClick: async () => {
        await plugin.sync.syncJust(item.path);
        ctx.refresh("state");
      },
    });
    const base =
      v.outcome === "conflict" ? "Needs your input" : v.outcome === "error" ? "Couldn't sync" : "Up to date";
    const status = card.createDiv("covault-wb-lib-row2");
    if (v.syncing) {
      status.appendText("Syncing… ");
      status.createSpan({ cls: "is-faint", text: `(${v.outcome === "idle" ? "was up to date" : base.toLowerCase()})` });
    } else {
      status.createSpan({ cls: v.outcome === "error" ? "is-red" : "", text: base });
    }
    const files = ctx.index.entriesFor(item.path).filter((e) => !e.ghost).length;
    status.appendText(
      ` · ${v.state.lastSyncedAt ? `synced ${relative(v.state.lastSyncedAt)}` : "not synced yet"}${ctx.index.has(item.path) ? ` · ${plural(files, "note")}` : ""}`,
    );
    const row3 = card.createDiv("covault-wb-lib-row3");
    const counts = countsOf(item);
    if (counts.conflict + counts.local + counts.incoming === 0) row3.createSpan({ cls: "covault-wb-tag is-ok", text: "All shared" });
    else badges(row3, counts);
  }
}
