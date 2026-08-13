import { Modal, setIcon, type App } from "obsidian";
import { createTwoFilesPatch } from "diff";
import type { FileCommit, GitEngine, RepoRef } from "../git/GitEngine";

function fhFormatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateStr =
    date.getFullYear() === now.getFullYear()
      ? `${MONTHS[date.getMonth()]} ${date.getDate()}`
      : `${MONTHS[date.getMonth()]} '${String(date.getFullYear()).slice(2)}`;
  if (mins < 1) return `${dateStr} · just now`;
  if (mins < 60) return `${dateStr} · ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${dateStr} · ${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${dateStr} · ${days}d ago`;
  const mos = Math.floor(days / 30);
  if (mos < 12) return `${dateStr} · ${mos}mo ago`;
  return `${dateStr} · ${Math.floor(mos / 12)}y ago`;
}

function fhParseStats(diffText: string): { adds: number; dels: number } {
  let adds = 0,
    dels = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) dels++;
  }
  return { adds, dels };
}

function fhRenderDiff(container: HTMLElement, diffText: string): void {
  container.empty();
  if (!diffText.trim()) {
    container.createEl("p", { cls: "covault-fh-diff-empty", text: "No changes." });
    return;
  }
  const table = container.createDiv({ cls: "covault-fh-diff-table" });
  let oldLine = 0,
    newLine = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1] ?? "1") - 1;
        newLine = parseInt(m[2] ?? "1") - 1;
      }
      continue;
    }
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("===") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }

    const row = table.createDiv({ cls: "covault-fh-diff-line" });
    const oldNumEl = row.createSpan({ cls: "covault-fh-diff-lno" });
    const newNumEl = row.createSpan({ cls: "covault-fh-diff-lno" });
    const textEl = row.createSpan({ cls: "covault-fh-diff-text" });
    textEl.textContent = line;
    if (line.startsWith("+")) {
      row.addClass("covault-fh-diff-add");
      newLine++;
      newNumEl.textContent = String(newLine);
    } else if (line.startsWith("-")) {
      row.addClass("covault-fh-diff-del");
      oldLine++;
      oldNumEl.textContent = String(oldLine);
    } else {
      oldLine++;
      newLine++;
      oldNumEl.textContent = String(oldLine);
      newNumEl.textContent = String(newLine);
    }
  }
}

/** File history with a commit list and a range-selectable diff pane,
 *  ported from agentic-git-sync's FileHistoryModal. */
export class FileHistoryModal extends Modal {
  private commits: FileCommit[] = [];
  private anchorIdx: number | null = 0;
  private rangeEndIdx: number | null = null;
  private listEl!: HTMLElement;
  private diffInfoEl!: HTMLElement;
  private diffStatsEl!: HTMLElement;
  private diffContentEl!: HTMLElement;

  constructor(
    app: App,
    private engine: GitEngine,
    private ref: RepoRef,
    private repoRelativePath: string,
    private displayPath: string,
    private currentUserEmail: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("covault-fh-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("covault-fh-content");

    // Header
    const header = contentEl.createDiv("covault-fh-header");
    const titleRow = header.createDiv("covault-fh-title-row");
    const iconWrap = titleRow.createSpan("covault-fh-title-icon");
    setIcon(iconWrap, "history");
    titleRow.createEl("h3", { text: "History" });

    const parts = this.displayPath.split("/");
    const subtitle = header.createDiv("covault-fh-subtitle");
    if (parts.length > 1) {
      subtitle.createSpan({ cls: "covault-fh-subtitle-dir", text: parts.slice(0, -1).join("/") + "/" });
    }
    subtitle.createSpan({ cls: "covault-fh-subtitle-name", text: parts[parts.length - 1] ?? this.displayPath });

    header.createDiv({
      cls: "covault-fh-hint",
      text: "Click · Shift+click for range · ↑↓ navigate · Shift+↑↓ extend range",
    });

    // Body
    const body = contentEl.createDiv("covault-fh-body");
    this.listEl = body.createDiv("covault-fh-list");
    const diffPane = body.createDiv("covault-fh-diff-pane");
    this.diffInfoEl = diffPane.createDiv("covault-fh-diff-info-bar");
    this.diffStatsEl = diffPane.createDiv("covault-fh-diff-stats");
    this.diffContentEl = diffPane.createDiv("covault-fh-diff-content");

    const footer = contentEl.createDiv("covault-fh-footer");
    footer.createEl("button", { text: "Close" }).onclick = () => this.close();

    // Keyboard navigation
    const move = (delta: number, extend: boolean) => {
      if (extend) {
        if (this.anchorIdx === null) return;
        const end = (this.rangeEndIdx ?? this.anchorIdx) + delta;
        if (end < 0 || end >= this.commits.length) return;
        this.rangeEndIdx = end;
        this.scrollIdxIntoView(end);
      } else {
        const next = (this.anchorIdx ?? (delta > 0 ? -1 : this.commits.length)) + delta;
        if (next < 0 || next >= this.commits.length) return;
        this.anchorIdx = next;
        this.rangeEndIdx = null;
        this.scrollIdxIntoView(next);
      }
      this.renderList();
      void this.updateDiff();
    };
    this.scope.register([], "ArrowDown", () => (move(1, false), false));
    this.scope.register([], "ArrowUp", () => (move(-1, false), false));
    this.scope.register(["Shift"], "ArrowDown", () => (move(1, true), false));
    this.scope.register(["Shift"], "ArrowUp", () => (move(-1, true), false));

    this.listEl.createEl("p", { cls: "covault-fh-loading", text: "Loading history…" });
    void this.engine
      .fileLog(this.ref, this.repoRelativePath)
      .then((commits) => {
        this.commits = commits;
        this.anchorIdx = commits.length > 0 ? 0 : null;
        this.renderList();
        void this.updateDiff();
      })
      .catch((e: Error) => {
        this.listEl.empty();
        this.listEl.createEl("p", { cls: "covault-fh-error", text: `Couldn't load history — ${e.message}` });
      });
  }

  private scrollIdxIntoView(idx: number): void {
    const el = this.listEl.querySelectorAll(".covault-fh-row")[idx] as HTMLElement | undefined;
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  private selectedRange(): [number, number] | null {
    if (this.anchorIdx === null) return null;
    const end = this.rangeEndIdx ?? this.anchorIdx;
    return [Math.min(this.anchorIdx, end), Math.max(this.anchorIdx, end)];
  }

  private renderList(): void {
    this.listEl.empty();
    if (this.commits.length === 0) {
      this.listEl.createEl("p", { cls: "covault-fh-empty", text: "No history for this note yet." });
      return;
    }
    const range = this.selectedRange();
    for (let i = 0; i < this.commits.length; i++) {
      this.renderRow(i, this.commits[i]!, range !== null && i >= range[0] && i <= range[1]);
    }
  }

  private renderRow(idx: number, commit: FileCommit, selected: boolean): void {
    const row = this.listEl.createDiv("covault-fh-row");
    if (selected) row.addClass("is-selected");

    const isLocal = commit.authorEmail === this.currentUserEmail;
    const originIcon = row.createSpan({ cls: "covault-fh-origin-icon" });
    originIcon.setAttribute("aria-label", isLocal ? "Your change" : "Teammate's change");
    setIcon(originIcon, isLocal ? "upload" : "download");
    originIcon.addClass(isLocal ? "is-local" : "is-remote");

    row.createSpan({ cls: "covault-fh-message", text: commit.message });
    row.createSpan({ cls: "covault-fh-hash", text: commit.hash.slice(0, 7) });
    row.createSpan({ cls: "covault-fh-date", text: fhFormatDate(commit.date) });

    row.addEventListener("click", (e: MouseEvent) => {
      if (e.shiftKey && this.anchorIdx !== null) {
        this.rangeEndIdx = idx;
      } else {
        const range = this.selectedRange();
        if (range !== null && range[0] === range[1] && range[0] === idx) {
          this.anchorIdx = null;
          this.rangeEndIdx = null;
        } else {
          this.anchorIdx = idx;
          this.rangeEndIdx = null;
        }
      }
      this.renderList();
      void this.updateDiff();
    });
  }

  private async updateDiff(): Promise<void> {
    const range = this.selectedRange();
    this.diffInfoEl.empty();
    this.diffStatsEl.empty();
    this.diffStatsEl.removeClass("has-stats");

    if (range === null) {
      this.diffContentEl.empty();
      this.diffContentEl.createEl("p", { cls: "covault-fh-diff-placeholder", text: "← Select a change to view it" });
      return;
    }

    this.diffContentEl.empty();
    this.diffContentEl.createEl("p", { cls: "covault-fh-loading", text: "Loading…" });

    const [minIdx, maxIdx] = range;
    const newest = this.commits[minIdx]!; // smaller idx = newer
    const oldest = this.commits[maxIdx]!;
    const isSingle = minIdx === maxIdx;

    if (isSingle) {
      this.diffInfoEl.createSpan({ cls: "covault-fh-diff-hash", text: newest.hash.slice(0, 7) });
      this.diffInfoEl.createSpan({ cls: "covault-fh-diff-msg", text: newest.message });
      this.diffInfoEl.createSpan({
        cls: "covault-fh-diff-author",
        text: `${newest.authorName} · ${newest.date.toLocaleDateString()}`,
      });
    } else {
      this.diffInfoEl.createSpan({
        cls: "covault-fh-diff-hash",
        text: `${oldest.hash.slice(0, 7)} → ${newest.hash.slice(0, 7)}`,
      });
      this.diffInfoEl.createSpan({ cls: "covault-fh-diff-msg", text: `${maxIdx - minIdx + 1} changes combined` });
    }

    try {
      // Old side: the state before the oldest selected commit.
      const oldBase = oldest.parents[0] ?? null;
      const oldText = oldBase ? ((await this.engine.readFileAt(this.ref, oldBase, this.repoRelativePath)) ?? "") : "";
      const newText = (await this.engine.readFileAt(this.ref, newest.hash, this.repoRelativePath)) ?? "";
      const diff =
        oldText === newText ? "" : createTwoFilesPatch("a", "b", oldText, newText, undefined, undefined, { context: 3 });

      const { adds, dels } = fhParseStats(diff);
      const hasStats = adds > 0 || dels > 0;
      this.diffStatsEl.toggleClass("has-stats", hasStats);
      if (hasStats) {
        this.diffStatsEl.createSpan({ cls: "covault-fh-stat-add", text: `+${adds}` });
        this.diffStatsEl.createSpan({ cls: "covault-fh-stat-del", text: `−${dels}` });
      }
      fhRenderDiff(this.diffContentEl, diff);
    } catch (e) {
      this.diffContentEl.empty();
      this.diffContentEl.createEl("p", {
        cls: "covault-fh-error",
        text: `Couldn't load the change — ${(e as Error).message}`,
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
