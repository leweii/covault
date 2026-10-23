/**
 * Drag handles on the workbench's side panels. The width lives in a CSS
 * custom property on the view root, so the layout is plain CSS; the
 * handle only moves the number. Widths persist per device and vault
 * through Obsidian's local storage, and a double-click puts one back.
 */
import type { App } from "obsidian";

export interface ResizeSpec {
  /** Storage key, per panel. */
  key: string;
  /** The custom property the layout reads, e.g. "--covault-wb-tree-w". */
  cssVar: string;
  defaultPx: number;
  minPx: number;
  maxPx: number;
  /** Which way the panel grows when the handle moves right. */
  grows: "right" | "left";
}

function clamp(spec: ResizeSpec, px: number): number {
  return Math.min(spec.maxPx, Math.max(spec.minPx, Math.round(px)));
}

/** Apply the saved (or default) width to the root before first paint. */
export function applySavedWidth(app: App, root: HTMLElement, spec: ResizeSpec): void {
  const saved = app.loadLocalStorage(spec.key) as unknown;
  const px = typeof saved === "number" && Number.isFinite(saved) ? clamp(spec, saved) : spec.defaultPx;
  root.style.setProperty(spec.cssVar, `${px}px`);
}

export function installResizer(app: App, root: HTMLElement, handle: HTMLElement, spec: ResizeSpec): void {
  handle.addClass("covault-wb-resizer");
  handle.setAttribute("aria-label", "Drag to resize · double-click to reset");
  const current = () => parseFloat(root.style.getPropertyValue(spec.cssVar)) || spec.defaultPx;

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = current();
    handle.addClass("is-dragging");
    document.body.addClass("covault-wb-resizing");
    const move = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      root.style.setProperty(spec.cssVar, `${clamp(spec, startW + (spec.grows === "right" ? delta : -delta))}px`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      handle.removeClass("is-dragging");
      document.body.removeClass("covault-wb-resizing");
      app.saveLocalStorage(spec.key, current());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  handle.addEventListener("dblclick", () => {
    root.style.setProperty(spec.cssVar, `${spec.defaultPx}px`);
    app.saveLocalStorage(spec.key, null);
  });
}
