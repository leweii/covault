/**
 * One compact alert per library that couldn't sync: how often, since
 * when, the error, and the two ways out — Retry here, or hand it to
 * Claudian with the request already written.
 *
 * While the library is syncing again the alert turns into a loading
 * state and stays; it only leaves when a round ends clean.
 */
import { setIcon } from "obsidian";
import { repoOutcome } from "../model";
import type { WorkbenchContext } from "./context";
import { button, relative } from "./util";

export function renderFailures(ctx: WorkbenchContext, el: HTMLElement): void {
  el.empty();
  const { plugin } = ctx;
  for (const item of plugin.syncItems()) {
    const s = plugin.sync.state(item.path);
    if (repoOutcome(s) !== "error") continue;
    const syncing = plugin.sync.isSyncing(item.path);
    const label = item.path === "" ? "My knowledge base" : (item.label ?? item.path);
    const times = s.failures ?? 1;
    const alert = el.createDiv(`covault-wb-alert ${syncing ? "is-retrying" : ""}`);
    const icon = alert.createSpan("covault-wb-alert-icon");
    setIcon(icon, syncing ? "refresh-cw" : "alert-triangle");
    if (syncing) icon.addClass("covault-wb-spin");

    const msg = alert.createDiv("covault-wb-alert-msg");
    const line = msg.createDiv();
    if (syncing) {
      line.createEl("b", { text: `Retrying ${label}…` });
      line.createSpan({ cls: "is-muted", text: ` · it failed ${times}× before — this note stays until it succeeds` });
    } else {
      line.createEl("b", { text: `${label} couldn't sync` });
      line.createSpan({
        cls: "is-muted",
        text: ` · failed ${times}× · ${s.lastSyncedAt ? `last success ${relative(s.lastSyncedAt)}` : "never synced yet"} · your notes are safe here`,
      });
    }
    msg.createDiv({ cls: "covault-wb-alert-err", text: s.detail ?? "" });

    button(alert, {
      text: "Retry",
      icon: "refresh-cw",
      cls: syncing ? "is-syncing" : "",
      disabled: syncing,
      onClick: async () => {
        await plugin.sync.syncJust(item.path);
        ctx.refresh("state");
      },
    });
    button(alert, {
      text: "Open in Claudian",
      icon: "bot",
      cls: "mod-cta",
      disabled: syncing,
      onClick: () => void ctx.openClaudianFor(item, s.detail ?? "sync failed"),
    });
  }
}
