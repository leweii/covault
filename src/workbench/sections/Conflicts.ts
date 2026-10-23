/**
 * The notes that need a decision: one card listing every conflicted
 * note across libraries, who it collides with, and a Resolve button that
 * opens the resolver on that note. The note's name opens it.
 */
import { setIcon } from "obsidian";
import type { WorkbenchContext } from "./context";
import { button } from "./util";

export function renderConflicts(ctx: WorkbenchContext, el: HTMLElement): void {
  el.empty();
  const { plugin } = ctx;
  const pending = plugin.sync.pendingConflicts();
  const rows = pending.flatMap((p) =>
    p.filepaths.map((rel) => ({
      item: p.item,
      rel,
      path: p.item.path ? `${p.item.path}/${rel}` : rel,
      who: p.authors?.[rel],
    })),
  );
  if (rows.length === 0) return;

  const card = el.createDiv("covault-wb-card is-conflicts");
  const head = card.createDiv("covault-wb-card-head");
  setIcon(head.createSpan(), "alert-triangle");
  head.createEl("h3", { text: `${rows.length} note(s) need your input` });
  button(head, { text: "Resolve all…", cls: "mod-cta", onClick: () => plugin.openConflictModal() });

  for (const row of rows) {
    const line = card.createDiv(`covault-wb-crow ${ctx.state.selectedPath === row.path ? "is-sel" : ""}`);
    line.createSpan({ cls: "covault-wb-mark is-conflict", text: "!" });
    const text = line.createDiv("covault-wb-crow-text");
    const name = text.createEl("a", { cls: "covault-wb-flink", text: row.rel.split("/").pop() ?? row.rel });
    name.onclick = () => ctx.showFile(row.path);
    text.createSpan({ cls: "is-muted", text: ` — ${row.item.label ?? (row.item.path || "My knowledge base")}/${row.rel}` });
    text.createDiv({
      cls: "is-muted covault-wb-crow-sub",
      text: `You and ${row.who ?? "a teammate"} changed this note. The AI couldn't merge it with confidence.`,
    });
    button(line, {
      text: "Resolve",
      icon: "wrench",
      cls: "mod-cta",
      onClick: () => plugin.openConflictModal(row.item.path, row.rel),
    });
  }
}
