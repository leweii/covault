/**
 * Hand a sync that Covault couldn't finish to Claudian (the Claude Code
 * plugin), as a new conversation with the request already typed in.
 *
 * Claudian has no public API. What this does is exactly what its own
 * "Add to Claudian" file-menu item does — activate the view, append to
 * the input — so it is as stable as Claudian's own feature. Every step is
 * feature-checked; if any is missing the prompt goes to the clipboard
 * instead and the user is told to paste it. The request is never sent on
 * the user's behalf: they read it and press Enter.
 *
 * No `obsidian` value imports: the plugin lookup, clipboard and notices
 * are injected, so this is unit-tested with fakes.
 */

export interface ClaudianViewLike {
  startNewConversation?: () => Promise<void> | void;
  appendToActiveInput?: (text: string) => boolean | void;
  focusActiveInput?: () => void;
}

export interface ClaudianPluginLike {
  views?: {
    activateView?: () => Promise<void> | void;
    getView?: () => ClaudianViewLike | null | undefined;
  };
}

export interface ClaudianDeps {
  /** The enabled Claudian plugin instance, or null/undefined. */
  getPlugin: () => ClaudianPluginLike | null | undefined;
  copy: (text: string) => Promise<void>;
  notify: (message: string) => void;
  /** Claudian isn't installed or enabled — show the way to get it. */
  onMissing: () => void;
}

export type ClaudianOutcome = "prefilled" | "copied" | "missing";

export async function openInClaudian(deps: ClaudianDeps, prompt: string): Promise<ClaudianOutcome> {
  const plugin = deps.getPlugin();
  if (!plugin) {
    deps.onMissing();
    return "missing";
  }
  try {
    const views = plugin.views;
    if (!views?.activateView || !views.getView) throw new Error("no views");
    await views.activateView();
    const view = views.getView();
    if (!view?.appendToActiveInput) throw new Error("no input");
    await view.startNewConversation?.();
    // A fresh conversation's view may be a different object.
    const target = views.getView() ?? view;
    if (!target.appendToActiveInput || target.appendToActiveInput(prompt) === false) throw new Error("append refused");
    target.focusActiveInput?.();
    return "prefilled";
  } catch {
    await deps.copy(prompt);
    deps.notify("Covault: Claudian is open — paste the request into the chat (⌘V) and send it.");
    return "copied";
  }
}

export interface SyncFixInput {
  /** Absolute vault path. */
  vaultBase: string;
  /** SyncItem path ("" = the personal knowledge base at the vault root). */
  repoPath: string;
  label: string;
  branch: string;
  /** Separate git directory (the personal KB keeps it outside the tree). */
  gitdir?: string;
  error: string;
}

/**
 * The request for Claude: where the repo is, what went wrong, and the
 * rules Covault itself follows — never rewrite shared history, never
 * guess when two versions contradict each other.
 */
export function buildSyncFixPrompt(input: SyncFixInput): string {
  const dir = input.repoPath ? `${input.vaultBase}/${input.repoPath}` : input.vaultBase;
  const where = input.gitdir
    ? `The folder is \`${dir}\`. Its git directory is separate: run every git command with ` +
      `\`GIT_DIR="${input.gitdir}" GIT_WORK_TREE="${dir}"\` (there is no .git inside the folder).`
    : `The folder is \`${dir}\` (a git repository).`;
  return [
    `Covault — an Obsidian plugin that syncs the knowledge library "${input.label}" with GitHub — couldn't finish a sync. Please finish it.`,
    "",
    where,
    `Branch: ${input.branch}, remote: origin.`,
    `What Covault saw: ${input.error}`,
    "",
    "Please:",
    "1. Commit any uncommitted changes in the folder with a short message.",
    `2. Pull origin ${input.branch} and merge. Never rebase, never force-push, never rewrite history — teammates have clones.`,
    "3. If notes conflict, merge them so both sides' meaning survives. If two versions state contradicting facts, keep my version and list the file for me to decide.",
    `4. Push to origin ${input.branch}.`,
    "5. If the push is refused or the network is unreachable, stop and tell me what you found — don't work around it.",
    "",
    "Finish with a short summary: what you did, which notes changed, and anything I need to check.",
  ].join("\n");
}
