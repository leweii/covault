/**
 * The sync log: one row per round, newest first, from the structured
 * history. A row opens to the files it carried — ↑ what this device
 * shared, ↓ what teammates' changes brought in, each with its author.
 * A failed round offers to hand itself to Claudian.
 */
import { setIcon } from "obsidian";
import type { SyncRecord } from "../../debug/syncHistory";
import type { LocalChange } from "../../git/GitEngine";
import { repoOutcome } from "../model";
import type { WorkbenchContext } from "./context";
import { button, clockWithSeconds } from "./util";

const KIND_MARK: Record<LocalChange["kind"], string> = { added: "A", modified: "M", deleted: "D" };
const SHOWN = 200;

export function renderSyncLog(ctx: WorkbenchContext, el: HTMLElement): void {
  el.empty();
  const { plugin, state } = ctx;
  const records = plugin.syncHistory.records(SHOWN);
  if (records.length === 0) {
    el.createDiv({ cls: "covault-wb-empty", text: "No syncs recorded yet — the first round will show up here." });
    return;
  }
  const items = plugin.syncItems();
  for (const r of records) {
    const entry = el.createDiv("covault-wb-log-entry");
    const line = entry.createDiv("covault-wb-log-line");
    line.createSpan({ cls: "covault-wb-log-time", text: clockWithSeconds(r.at) });
    line.createSpan({
      cls: `covault-wb-tag is-${r.status === "ok" ? "ok" : r.status === "error" ? "err" : "skip"}`,
      text: r.status === "ok" ? "Synced" : r.status === "error" ? "Failed" : "Needs input",
    });
    line.createSpan({ cls: "covault-wb-log-lib", text: r.library });
    line.createSpan({ cls: "covault-wb-log-sum", text: r.summary });
    if (r.status === "error") {
      const item = items.find((i) => i.path === r.repoPath);
      button(line, {
        text: "Fix with Claudian",
        icon: "bot",
        cls: "covault-wb-btn-sm",
        onClick: () => {
          // Still failing → the alert has the current error and both ways out.
          if (item && repoOutcome(plugin.sync.state(item.path)) === "error") ctx.scrollToFailures();
          else if (item) void ctx.openClaudianFor(item, r.error ?? r.summary);
        },
      });
    }
    line.createSpan({ cls: "covault-wb-tag", text: r.trigger });
    line.createSpan({ cls: "covault-wb-log-dur", text: `${(r.ms / 1000).toFixed(1)}s` });

    const hasFiles = r.files.length + (r.incoming?.files.length ?? 0) > 0;
    if (hasFiles) {
      setIcon(line.createSpan("covault-wb-log-chev"), state.expandedLog.has(r.at) ? "chevron-down" : "chevron-right");
      line.addClass("is-openable");
      line.onclick = () => {
        if (state.expandedLog.has(r.at)) state.expandedLog.delete(r.at);
        else state.expandedLog.add(r.at);
        ctx.refresh("log");
      };
    }
    if (hasFiles && state.expandedLog.has(r.at)) renderFiles(ctx, entry.createDiv("covault-wb-log-files"), r);
  }
}

function renderFiles(ctx: WorkbenchContext, el: HTMLElement, r: SyncRecord): void {
  const lib = ctx.plugin.syncItems().find((i) => i.path === r.repoPath);
  const link = (parent: HTMLElement, rel: string) => {
    const full = lib ? (lib.path ? `${lib.path}/${rel}` : rel) : null;
    const exists = full !== null && ctx.app.vault.getAbstractFileByPath(full) !== null;
    if (!exists) {
      parent.createSpan({ text: rel });
      return;
    }
    const a = parent.createEl("a", { cls: "covault-wb-flink", text: rel });
    a.onclick = (e) => {
      e.stopPropagation();
      ctx.showFile(full);
    };
  };
  for (const f of r.files) {
    const row = el.createDiv();
    row.createSpan({ cls: "covault-wb-arrow is-up", text: "↑" });
    row.createSpan({ cls: "covault-wb-kind", text: KIND_MARK[f.kind] });
    link(row, f.filepath);
  }
  for (const f of r.incoming?.files ?? []) {
    const row = el.createDiv();
    row.createSpan({ cls: "covault-wb-arrow is-down", text: "↓" });
    row.createSpan({ cls: "covault-wb-kind", text: KIND_MARK[f.kind] });
    link(row, f.filepath);
    if (f.author) row.createSpan({ cls: "is-faint", text: ` — ${f.author}` });
  }
}
