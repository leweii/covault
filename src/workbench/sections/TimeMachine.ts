/**
 * The Time Machine: one note's whole history, over the workbench.
 *
 * A timeline on the right lists every version (Today / Yesterday / by
 * date), with a checkbox each; the page in the middle shows the selected
 * version as the document it was, with what changed marked in place.
 * Tick several consecutive versions and the page shows their changes
 * combined, each added line credited to the teammate who wrote it.
 * Restore makes an old version the current text as a new change —
 * nothing in history is lost — and the next sync shares it.
 *
 * Content is read from git lazily and cached per version; the stats on
 * each row fill in as they are computed. A clone that only holds recent
 * history says so and offers to load the rest.
 */
import { Notice, TFile, setIcon } from "obsidian";
import type { RepoRef } from "../../git/GitEngine";
import { isLfsPath } from "../../git/lfs";
import { creditAdditions, diffStats, growRange, lineDiff, rangeBetween, single, toggleInRange, type Range } from "../lineDiff";
import { applySavedWidth, installResizer, type ResizeSpec } from "../resizable";
import { assembleVersions, dayLabel, type Version } from "../versions";
import type { WorkbenchContext } from "./context";
import { button, clock, dateTime } from "./util";

const TL_W: ResizeSpec = { key: "covault-wb-tl-w", cssVar: "--covault-wb-tl-w", defaultPx: 340, minPx: 240, maxPx: 620, grows: "left" };
const DEPTH = 200;

export class TimeMachine {
  private el: HTMLElement;
  private path: string | null = null;
  private ref: RepoRef | null = null;
  private rel = "";
  private label = "";
  private versions: Version[] = [];
  private texts = new Map<string, string>();
  private stats = new Map<string, { added: number; deleted: number }>();
  private sel: Range = single(0);
  private anchor = 0;
  private shallow = false;
  private loading = false;
  private error: string | null = null;
  private busy: "restore" | "deepen" | null = null;
  /** Bumped on every open/close/load; late async work checks it. */
  private token = 0;

  constructor(
    private ctx: () => WorkbenchContext,
    host: HTMLElement,
  ) {
    this.el = host.createDiv("covault-wb-tm");
    this.el.tabIndex = 0;
    applySavedWidth(ctx().app, this.el, TL_W);
    this.el.onkeydown = (e) => this.onKey(e);
  }

  isOpen(): boolean {
    return this.path !== null;
  }

  async open(vaultPath: string): Promise<void> {
    const ctx = this.ctx();
    const h = ctx.plugin.historyContextFor(vaultPath);
    if (!h) {
      new Notice(`Covault: ${vaultPath} isn't in a synced library.`);
      return;
    }
    this.path = vaultPath;
    this.ref = h.ref;
    this.rel = h.relPath;
    this.label = h.label;
    this.versions = [];
    this.texts.clear();
    this.stats.clear();
    this.sel = single(0);
    this.anchor = 0;
    this.error = null;
    this.loading = true;
    this.el.addClass("is-open");
    this.render();
    this.el.focus();
    await this.load();
  }

  close(): void {
    this.token++;
    this.path = null;
    this.el.removeClass("is-open");
    this.el.empty();
  }

  // ── Data ───────────────────────────────────────────────────

  private async load(): Promise<void> {
    const token = ++this.token;
    const ctx = this.ctx();
    const { engine } = ctx.plugin;
    const ref = this.ref!;
    try {
      const [log, shallow] = await Promise.all([engine.fileLog(ref, this.rel, DEPTH), engine.isShallow(ref)]);
      const head = log[0]?.hash;
      const [workText, headText] = await Promise.all([
        engine.readWorkFile(ref, this.rel).catch(() => null),
        head ? engine.readFileAt(ref, head, this.rel) : Promise.resolve(null),
      ]);
      if (token !== this.token) return;
      this.shallow = shallow;
      this.versions = assembleVersions(log, workText, headText, ctx.plugin.gitAuthorEmail());
      if (workText !== null) this.texts.set("local", workText);
      if (head && headText !== null) this.texts.set(head, headText);
      this.sel = single(Math.min(this.sel.lo, Math.max(0, this.versions.length - 1)));
      this.anchor = this.sel.lo;
      this.loading = false;
      this.render();
      void this.fillStats(token);
    } catch (e) {
      if (token !== this.token) return;
      this.loading = false;
      this.error = (e as Error).message;
      this.render();
    }
  }

  private async text(key: string): Promise<string> {
    const cached = this.texts.get(key);
    if (cached !== undefined) return cached;
    const { engine } = this.ctx().plugin;
    const t =
      key === "local"
        ? await engine.readWorkFile(this.ref!, this.rel).catch(() => "")
        : ((await engine.readFileAt(this.ref!, key, this.rel)) ?? "");
    this.texts.set(key, t);
    return t;
  }

  /** The text before version k: the next-older version, or nothing. */
  private async baseText(k: number): Promise<string> {
    const older = this.versions[k + 1];
    return older ? this.text(older.key) : "";
  }

  /** Row stats, oldest first, so the visible top rows don't wait on a long tail. */
  private async fillStats(token: number): Promise<void> {
    for (let k = 0; k < this.versions.length; k++) {
      const v = this.versions[k]!;
      if (this.stats.has(v.key)) continue;
      const [base, text] = await Promise.all([this.baseText(k), this.text(v.key)]);
      if (token !== this.token) return;
      const s = diffStats(base, text);
      this.stats.set(v.key, s);
      const cell = this.el.querySelector<HTMLElement>(`[data-stats="${CSS.escape(v.key)}"]`);
      if (cell) this.paintStats(cell, s);
    }
  }

  private paintStats(cell: HTMLElement, s: { added: number; deleted: number }): void {
    cell.empty();
    cell.createSpan({ cls: "is-add", text: `+${s.added}` });
    cell.appendText(" ");
    cell.createSpan({ cls: "is-del", text: `−${s.deleted}` });
  }

  // ── Selection ──────────────────────────────────────────────

  private select(k: number): void {
    this.sel = single(k);
    this.anchor = k;
    this.render();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.path) return;
    const n = this.versions.length;
    if (e.key === "Escape") {
      this.close();
      e.preventDefault();
    } else if (e.key === "ArrowDown" && n) {
      this.sel = e.shiftKey ? growRange(this.sel, "older", n) : single(Math.min(n - 1, this.sel.lo + 1));
      if (!e.shiftKey) this.anchor = this.sel.lo;
      this.render();
      e.preventDefault();
    } else if (e.key === "ArrowUp" && n) {
      this.sel = e.shiftKey ? growRange(this.sel, "newer", n) : single(Math.max(0, this.sel.lo - 1));
      if (!e.shiftKey) this.anchor = this.sel.lo;
      this.render();
      e.preventDefault();
    }
  }

  // ── Actions ────────────────────────────────────────────────

  private async restore(): Promise<void> {
    const v = this.versions[this.sel.lo];
    if (!v || v.local || !this.path) return;
    this.busy = "restore";
    this.render();
    try {
      const text = await this.text(v.key);
      await this.ctx().plugin.writeVaultNote(this.path, text);
      new Notice(`Covault: restored the version from ${dateTime(v.at)} — it's a new change, shared on the next sync.`);
      await this.load();
    } catch (e) {
      new Notice(`Covault: couldn't restore — ${(e as Error).message}`);
    } finally {
      this.busy = null;
      this.render();
    }
  }

  private async deepen(): Promise<void> {
    if (!this.ref) return;
    this.busy = "deepen";
    this.render();
    try {
      await this.ctx().plugin.engine.deepenHistory(this.ref);
      this.stats.clear();
      await this.load();
    } catch (e) {
      new Notice(`Covault: couldn't load older history — ${(e as Error).message}`);
    } finally {
      this.busy = null;
      this.render();
    }
  }

  // ── Rendering ──────────────────────────────────────────────

  private render(): void {
    const el = this.el;
    el.empty();
    if (!this.path) return;
    const ctx = this.ctx();
    const vers = this.versions;
    const { lo, hi } = this.sel;
    const many = hi > lo;
    const name = (this.rel.split("/").pop() ?? this.rel).replace(/\.md$/i, "");
    const file = ctx.app.vault.getAbstractFileByPath(this.path);

    // ── Header ──
    const head = el.createDiv("covault-wb-tm-head");
    button(head, { text: "Workbench", icon: "arrow-left", onClick: () => this.close() });
    setIcon(head.createSpan("covault-wb-tm-icon"), "history");
    const ttl = head.createDiv("covault-wb-tm-ttl");
    ttl.createEl("b", { text: name });
    ttl.createDiv({
      cls: "is-muted",
      text: `${this.label} / ${this.rel} · ${vers.length} ${vers.length === 1 ? "version" : "versions"}${this.shallow ? " · older history not loaded" : ""}`,
    });
    const target = vers[lo];
    button(head, {
      text: this.busy === "restore" ? "Restoring…" : "Restore this version",
      icon: "undo-2",
      disabled: many || lo === 0 || !target || target.local || this.busy !== null,
      title: many ? "Select a single version to restore it" : lo === 0 ? "This is already the current version" : "",
      onClick: () => void this.restore(),
    });
    if (file instanceof TFile) {
      button(head, { text: "Open note", cls: "mod-cta", onClick: () => void ctx.app.workspace.getLeaf(false).openFile(file) });
    }

    // ── Selection bar ──
    const bar = el.createDiv("covault-wb-tm-selbar");
    if (many) {
      const picked = vers.slice(lo, hi + 1);
      const who = [...new Set(picked.map((v) => v.author))];
      bar.createEl("b", { text: `${picked.length} versions selected` });
      bar.appendText(` · ${dateTime(vers[hi]!.at)} → ${dayLabel(vers[lo]!.at)} · by ${who.join(", ")} — showing their changes combined`);
      button(bar, { text: "Select one", cls: "covault-wb-btn-sm", onClick: () => this.select(lo) });
    } else {
      bar.appendText("Showing the version with its changes marked in place · tick more boxes to combine several versions · ");
      bar.createEl("b", { text: "Shift-click" });
      bar.appendText(" selects a range");
    }

    // ── Body: stage | timeline ──
    const body = el.createDiv("covault-wb-tm-body");
    const stage = body.createDiv("covault-wb-tm-stage");
    if (this.loading) {
      stage.createDiv({ cls: "covault-wb-empty", text: "Loading history…" });
    } else if (this.error) {
      stage.createDiv({ cls: "covault-wb-empty is-red", text: `Couldn't read the history — ${this.error}` });
    } else if (vers.length === 0) {
      stage.createDiv({
        cls: "covault-wb-empty",
        text: this.shallow ? "This device only holds recent history, and this note didn't change in it." : "No history for this note yet.",
      });
    } else {
      const scrub = stage.createDiv("covault-wb-tm-scrub");
      scrub.toggleClass("is-hidden", many);
      scrub.createSpan({ text: new Date(vers.at(-1)!.at).toLocaleDateString([], { month: "short", day: "numeric" }) });
      const range = scrub.createEl("input", { attr: { type: "range", min: "0", max: String(vers.length - 1), value: String(vers.length - 1 - lo) } });
      range.oninput = () => this.select(vers.length - 1 - Number(range.value));
      scrub.createSpan({ text: vers[0]!.local ? "Now (this device)" : "Now" });

      const stack = stage.createDiv("covault-wb-tm-stack");
      if (lo < vers.length - 1) stack.createDiv("covault-wb-tm-ghost is-1");
      if (lo < vers.length - 2) stack.createDiv("covault-wb-tm-ghost is-2");
      const page = stack.createDiv("covault-wb-tm-page");
      const ph = page.createDiv("covault-wb-tm-pagehead");
      const v = vers[lo]!;
      if (many) {
        ph.createEl("b", { text: `Changes in ${hi - lo + 1} versions` });
        ph.appendText(` — ${dateTime(vers[hi]!.at)} → ${dayLabel(v.at)}`);
      } else {
        if (v.local) ph.createSpan({ cls: "covault-wb-mark is-local", text: "●" });
        ph.createEl("b", { text: v.message });
        ph.appendText(` — ${v.author}, ${dateTime(v.at)}`);
      }
      ph.createSpan("covault-wb-tm-pagestats");
      page.createDiv("covault-wb-tm-doc");
    }

    const tl = body.createDiv("covault-wb-tm-tl");
    installResizer(ctx.app, this.el, tl.createDiv(), TL_W);
    tl.addClass(many ? "is-multi" : "is-single");
    let lastDay = "";
    vers.forEach((v, k) => {
      const day = dayLabel(v.at);
      if (day !== lastDay) {
        tl.createDiv({ cls: "covault-wb-tm-day", text: day });
        lastDay = day;
      }
      const selected = k >= lo && k <= hi;
      const row = tl.createDiv({
        cls: `covault-wb-ver ${selected ? "is-sel" : ""} ${v.local ? "is-local" : ""} ${k === 0 && !v.local ? "is-current" : ""}`,
      });
      const check = row.createSpan({ cls: "covault-wb-ver-check", text: "✓", attr: { role: "checkbox", "aria-checked": String(selected) } });
      check.onclick = (e) => {
        e.stopPropagation();
        const { sel, refused } = toggleInRange(this.sel, k);
        if (refused) {
          new Notice("Covault: changes combine over consecutive versions — untick from the top or bottom of the selection.");
          return;
        }
        this.sel = sel;
        this.anchor = k;
        this.render();
      };
      row.createSpan("covault-wb-ver-dot");
      const info = row.createDiv("covault-wb-ver-info");
      info.createDiv({ cls: "covault-wb-ver-msg", text: v.message });
      info.createDiv({
        cls: "is-muted",
        text: `${v.author} · ${clock(v.at)}${k === 0 ? (v.local ? " · this device" : " · current") : ""}`,
      });
      const stats = row.createSpan({ cls: "covault-wb-ver-stats", attr: { "data-stats": v.key } });
      const s = this.stats.get(v.key);
      if (s) this.paintStats(stats, s);
      else stats.setText("…");
      row.onclick = (e) => {
        if (e.shiftKey) {
          this.sel = rangeBetween(this.anchor, k);
          this.render();
        } else this.select(k);
      };
    });
    if (this.shallow && !this.loading) {
      const more = tl.createDiv("covault-wb-tm-more");
      more.createDiv({ cls: "is-muted", text: "Older history isn't on this device yet." });
      button(more, {
        text: this.busy === "deepen" ? "Loading…" : "Load older history",
        icon: "download",
        disabled: this.busy !== null,
        onClick: () => void this.deepen(),
      });
    }

    // ── Footer ──
    const foot = el.createDiv("covault-wb-tm-foot");
    const kbd = (t: string) => foot.createEl("kbd", { text: t });
    kbd("↑");
    kbd("↓");
    foot.appendText(" step through versions · ");
    kbd("Shift");
    foot.appendText("+");
    kbd("↑↓");
    foot.appendText(" or tick boxes to combine versions · ");
    kbd("Esc");
    foot.appendText(" back to the workbench");

    void this.renderPage(this.token);
  }

  /** The document with its changes marked — async, since the texts come from git. */
  private async renderPage(token: number): Promise<void> {
    const doc = this.el.querySelector<HTMLElement>(".covault-wb-tm-doc");
    const statsEl = this.el.querySelector<HTMLElement>(".covault-wb-tm-pagestats");
    if (!doc || !statsEl) return;
    const { lo, hi } = this.sel;
    const vers = this.versions;
    if (isLfsPath(this.rel)) {
      doc.createDiv({ cls: "covault-wb-empty", text: "Attachments have no text to compare — pick a version and use Restore." });
      return;
    }
    const picked = vers.slice(lo, hi + 1);
    const [base, ...texts] = await Promise.all([this.baseText(hi), ...picked.map((v) => this.text(v.key))]);
    if (token !== this.token) return;
    const newest = texts[0] ?? "";
    const ops = lineDiff(base, newest);
    const many = hi > lo;
    const credits = many ? creditAdditions(ops, picked.map((v, i) => ({ text: texts[i] ?? "", author: v.author })), base) : [];
    const s = diffStats(base, newest);
    statsEl.empty();
    statsEl.createSpan({ cls: "is-add", text: `+${s.added}` });
    statsEl.appendText(" ");
    statsEl.createSpan({ cls: "is-del", text: `−${s.deleted}` });
    statsEl.appendText(many ? " combined" : vers[hi + 1] ? " vs previous" : " first version");

    doc.empty();
    if (ops.length === 0) {
      doc.createDiv({ cls: "covault-wb-empty", text: "(empty note)" });
      return;
    }
    ops.forEach((op, i) => {
      const shape = op.text.startsWith("## ") ? "is-h2" : op.text.startsWith("# ") ? "is-h1" : /^[-*] /.test(op.text) ? "is-li" : "";
      const line = doc.createDiv({ cls: `covault-wb-dl is-${op.kind} ${shape}` });
      const text = op.text.replace(/^#{1,2} /, "").replace(/^[-*] /, "");
      line.createSpan({ text: text || " " });
      const by = credits[i];
      if (op.kind === "add" && by) line.createSpan({ cls: "covault-wb-dl-by", text: by });
    });
  }
}
