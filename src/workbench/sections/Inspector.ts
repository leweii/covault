/**
 * The inspector: one note's standing against the team, in the right
 * column. Where it is on the way from "edited" to "teammates have it",
 * its document status (set here, saved in the note), who changed it
 * last, and its recent history.
 *
 * The header and status card render at once from the index; the parts
 * that need git (last change, versions, recent history) fill in when
 * the log arrives, and are dropped if the user has moved on.
 */
import { Notice, TFile, setIcon } from "obsidian";
import type { FileCommit } from "../../git/GitEngine";
import { FileHistoryModal } from "../../ui/FileHistoryModal";
import { writeDocStatus, readDocStatus } from "../docStatus";
import { STATUS_TEXT, type FileEntry, type FileSyncStatus } from "../model";
import type { WorkbenchContext } from "./context";
import { button, relative } from "./util";

const TRACK: Record<FileSyncStatus, [string, string, string, string]> = {
  synced: ["done", "done", "done", "done"],
  local: ["warn", "", "", ""],
  pending: ["done", "warn", "", ""],
  incoming: ["done", "done", "done", "done"],
  conflict: ["done", "done", "bad", ""],
};
const HISTORY_DEPTH = 50;
const AVATAR_COLORS = ["#7c5cf5", "#2f9e6e", "#d9822b", "#3a8eef", "#c2477a"];

function avatar(parent: HTMLElement, name: string): void {
  const hash = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const el = parent.createSpan({ cls: "covault-wb-av", attr: { title: name } });
  el.style.background = AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
  el.setText(name === "You" ? "Y" : name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase());
}

/** A token per render so late git results for a previous note are ignored. */
let renderToken = 0;

export function renderInspector(ctx: WorkbenchContext, el: HTMLElement, path: string | null): void {
  const token = ++renderToken;
  // Keep the resize handle (first child); replace the rest.
  for (const child of Array.from(el.children).slice(1)) child.remove();
  if (path === null) {
    el.removeClass("is-open");
    return;
  }
  el.addClass("is-open");
  const { plugin, app, index } = ctx;
  const owner_ = plugin.repoItemForPath(path);
  const entry: FileEntry | undefined = index.all().find((e) => e.path === path);
  const fileObj = app.vault.getAbstractFileByPath(path);
  const file = fileObj instanceof TFile ? fileObj : null;
  const repoPath = entry?.repoPath ?? owner_?.path ?? "";
  const rel = entry?.rel ?? (repoPath ? path.slice(repoPath.length + 1) : path);
  const status: FileSyncStatus = entry?.status ?? "synced";
  const libLabel = owner_ ? (owner_.path === "" ? "My knowledge base" : (owner_.label ?? owner_.path)) : "—";
  const parts = rel.split("/");
  const name = (parts.at(-1) ?? rel).replace(/\.md$/i, "");

  // ── Header ──
  const head = el.createDiv("covault-wb-ix-head");
  const top = head.createDiv("covault-wb-ix-top");
  setIcon(top.createDiv("covault-wb-ix-fileicon"), "file");
  const title = top.createDiv("covault-wb-ix-title");
  title.createEl("h4", { text: entry?.ghost ? `${name} (deleted)` : name });
  const crumb = title.createDiv("covault-wb-ix-crumb");
  crumb.createSpan({ cls: "is-lib", text: libLabel });
  for (const p of parts.slice(0, -1)) {
    crumb.createSpan({ text: "/" });
    crumb.createSpan({ text: p });
  }
  const close = top.createEl("button", { cls: "clickable-icon covault-wb-ix-close", attr: { "aria-label": "Close" } });
  setIcon(close, "x");
  close.onclick = () => ctx.closeInspector();

  const actions = head.createDiv("covault-wb-ix-actions");
  if (file) {
    button(actions, { text: "Open note", cls: "mod-cta", onClick: () => void app.workspace.getLeaf(false).openFile(file) });
  }
  const history = plugin.historyContextFor(path);
  if (history) {
    button(actions, {
      text: "History",
      icon: "history",
      onClick: () => new FileHistoryModal(app, plugin.engine, history.ref, history.relPath, path, plugin.gitAuthorEmail()).open(),
    });
  }
  if (status === "conflict") {
    button(actions, { text: "Resolve", icon: "wrench", cls: "covault-wb-btn-danger", onClick: () => plugin.openConflictModal(repoPath, rel) });
  }
  if (status === "local" || status === "pending") {
    button(actions, {
      text: "Share now",
      icon: "refresh-cw",
      disabled: plugin.sync.isSyncing(repoPath),
      onClick: async () => {
        await plugin.sync.syncJust(repoPath);
        ctx.refresh("state");
      },
    });
  }

  const body = el.createDiv("covault-wb-ix-body");

  // ── Sync ──
  const syncSec = body.createDiv("covault-wb-ix-sec");
  syncSec.createDiv({ cls: "covault-wb-ix-label", text: "Sync" });
  const card = syncSec.createDiv(`covault-wb-ix-sync is-${status}`);
  const t = card.createDiv("covault-wb-ix-sync-t");
  t.createSpan({ cls: `covault-wb-mark is-${status}`, text: STATUS_TEXT[status].mark });
  t.appendText(STATUS_TEXT[status].label);
  const conflict = plugin.sync.pendingConflicts().find((p) => p.item.path === repoPath);
  const who = conflict?.authors?.[rel];
  card.createDiv({
    cls: "covault-wb-ix-sync-d",
    text:
      status === "conflict"
        ? `You and ${who ?? "a teammate"} changed the same part of this note. Resolve it to pick what to keep.`
        : status === "incoming" && entry?.author
          ? `${entry.author} changed this note; the latest version is already in your vault.`
          : STATUS_TEXT[status].desc,
  });
  const track = card.createDiv("covault-wb-track");
  ["Edited", "Saved", "Uploaded", "Teammates"].forEach((label, i) => {
    track.createDiv({ cls: `covault-wb-tk ${TRACK[status][i]}`, text: label });
  });

  // ── Document status ──
  const defs = plugin.settings.docStatuses;
  const current = file ? readDocStatus(app.metadataCache.getFileCache(file)?.frontmatter, defs) : null;
  const dsSec = body.createDiv("covault-wb-ix-sec");
  dsSec.createDiv({ cls: "covault-wb-ix-label", text: "Document status" });
  if (file && path.toLowerCase().endsWith(".md")) {
    const seg = dsSec.createDiv("covault-wb-ds-seg");
    for (const def of defs) {
      const b = seg.createEl("button", { cls: `covault-wb-ds-opt ${current?.def?.id === def.id ? "is-on" : ""}` });
      b.style.setProperty("--c", def.color);
      b.createSpan("covault-wb-ds-dot");
      b.createSpan({ text: def.label });
      b.onclick = () => void setStatus(ctx, file, current?.def?.id === def.id ? null : def);
    }
    const by = dsSec.createDiv("covault-wb-ds-by");
    if (current) {
      if (current.by) avatar(by, current.by);
      const bits = [current.def ? "" : `"${current.raw}" isn't in the team's list`, current.by ? `Set by ${current.by}` : "", current.at ? relative(current.at) : ""]
        .filter(Boolean)
        .join(" · ");
      by.appendText(bits || "Set outside Covault");
      const clear = by.createEl("button", { cls: "covault-wb-ds-clear", text: "Clear" });
      clear.onclick = () => void setStatus(ctx, file, null);
    } else {
      by.appendText("Not set — pick one above. It's saved in the note and shared with the team.");
    }
  } else {
    dsSec.createDiv({ cls: "is-muted covault-wb-ix-note", text: entry?.ghost ? "The note is gone from this device." : "Only notes carry a status." });
  }

  // ── Details + recent changes (filled when the log arrives) ──
  const detSec = body.createDiv("covault-wb-ix-sec");
  detSec.createDiv({ cls: "covault-wb-ix-label", text: "Details" });
  const facts = detSec.createDiv("covault-wb-facts");
  const fact = (icon: string, k: string): HTMLElement => {
    const key = facts.createSpan("covault-wb-fact-k");
    setIcon(key.createSpan(), icon);
    key.appendText(k);
    return facts.createSpan("covault-wb-fact-v");
  };
  fact("library", "Library").setText(libLabel);
  const lastEl = fact("clock", "Last change");
  const ghEl = fact("refresh-cw", "On GitHub");
  const verEl = fact("history", "Versions");
  ghEl.setText(
    status === "local" || status === "pending" ? "An older version" : status === "conflict" ? "Teammate's version" : "Same as here",
  );
  if (status === "local") {
    avatar(lastEl, "You");
    lastEl.appendText("You · not shared yet");
  } else lastEl.setText("…");
  verEl.setText("…");

  const recSec = body.createDiv("covault-wb-ix-sec");
  recSec.createDiv({ cls: "covault-wb-ix-label", text: "Recent changes" });
  const recent = recSec.createDiv("covault-wb-mini-tl");
  recent.createDiv({ cls: "is-faint", text: "Loading…" });

  if (!history) {
    lastEl.setText("—");
    verEl.setText("—");
    recent.empty();
    recent.createDiv({ cls: "is-faint", text: "Not in a synced library." });
    return;
  }
  void (async () => {
    let log: FileCommit[] = [];
    let shallow = false;
    try {
      [log, shallow] = await Promise.all([plugin.engine.fileLog(history.ref, history.relPath, HISTORY_DEPTH), plugin.engine.isShallow(history.ref)]);
    } catch {
      /* no history to show; the cells say so */
    }
    if (token !== renderToken) return;
    const me = plugin.gitAuthorEmail().toLowerCase();
    const nameOf = (c: FileCommit) => (c.authorEmail.toLowerCase() === me ? "You" : c.authorName);
    const versions = log.filter((c) => !c.shallowBoundary);
    if (status !== "local") {
      lastEl.empty();
      const top = versions[0];
      if (top) {
        avatar(lastEl, nameOf(top));
        lastEl.appendText(`${nameOf(top)} · ${relative(top.date.getTime())}`);
      } else lastEl.setText("—");
    }
    const oldest = versions.at(-1);
    verEl.setText(
      versions.length === 0
        ? shallow
          ? "Older history not loaded"
          : "—"
        : `${versions.length}${log.length >= HISTORY_DEPTH ? "+" : ""}${
            shallow ? " · older history not loaded" : oldest ? ` · first by ${nameOf(oldest)}, ${relative(oldest.date.getTime())}` : ""
          }`,
    );
    recent.empty();
    if (versions.length === 0) {
      recent.createDiv({ cls: "is-faint", text: shallow ? "Older history isn't loaded yet." : "No history yet." });
    }
    for (const c of versions.slice(0, 3)) {
      const it = recent.createDiv("covault-wb-mini-it");
      avatar(it, nameOf(c));
      const tx = it.createDiv("covault-wb-mini-tx");
      tx.createDiv({ text: c.message || "(no message)" });
      tx.createDiv({ cls: "is-faint", text: `${nameOf(c)} · ${relative(c.date.getTime())}` });
    }
    if (versions.length > 0) {
      const link = recSec.createEl("button", { cls: "covault-wb-ix-link" });
      link.createSpan({ text: `See all ${versions.length}${log.length >= HISTORY_DEPTH ? "+" : ""} versions` });
      setIcon(link.createSpan(), "chevron-right");
      link.onclick = () => new FileHistoryModal(app, plugin.engine, history.ref, history.relPath, path, plugin.gitAuthorEmail()).open();
    }
  })();
}

async function setStatus(ctx: WorkbenchContext, file: TFile, def: Parameters<typeof writeDocStatus>[1]): Promise<void> {
  const { plugin, app } = ctx;
  try {
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => writeDocStatus(fm, def, plugin.gitAuthorName()));
    new Notice(def ? `Covault: "${file.basename}" is now ${def.label} — shared with the team on the next sync.` : `Covault: status cleared on "${file.basename}".`);
  } catch (e) {
    new Notice(`Covault: couldn't update the status — ${(e as Error).message}`);
  }
  // The cache lags processFrontMatter; the "changed" event re-renders the
  // tree, and the inspector reads the cache again right away for the bar.
  window.setTimeout(() => ctx.refresh("inspector"), 150);
}
