/** Small DOM and time helpers shared by the workbench sections. */
import { setIcon } from "obsidian";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "3 min ago", "in 2 h", "just now". */
export function relative(at: number, now = Date.now()): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  const unit =
    abs < MIN ? "" : abs < HOUR ? `${Math.round(abs / MIN)} min` : abs < DAY ? `${Math.round(abs / HOUR)} h` : `${Math.round(abs / DAY)} d`;
  if (!unit) return diff >= 0 ? "in a moment" : "just now";
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** "7:40" under an hour, "1 h 12 min" above. */
export function countdown(untilAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((untilAt - now) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function clockWithSeconds(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(at: number): string {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export interface ButtonSpec {
  text?: string;
  icon?: string;
  cls?: string;
  title?: string;
  disabled?: boolean;
  /** May be async; the click handler doesn't wait for it. */
  onClick: (e: MouseEvent) => void | Promise<void>;
}

export function button(parent: HTMLElement, spec: ButtonSpec): HTMLButtonElement {
  const btn = parent.createEl("button", { cls: `covault-wb-btn ${spec.cls ?? ""}`.trim() });
  if (spec.icon) setIcon(btn.createSpan("covault-wb-btn-icon"), spec.icon);
  if (spec.text) btn.createSpan({ text: spec.text });
  if (spec.title) btn.setAttribute("aria-label", spec.title);
  btn.disabled = spec.disabled ?? false;
  btn.onclick = (e) => {
    e.stopPropagation();
    void spec.onClick(e);
  };
  return btn;
}

/** A small round status dot: idle (green) / syncing / conflict / error. */
export function stateDot(parent: HTMLElement, state: "idle" | "syncing" | "conflict" | "error", title?: string): HTMLElement {
  const dot = parent.createSpan({ cls: `covault-wb-dot is-${state}` });
  if (title) dot.setAttribute("aria-label", title);
  return dot;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
