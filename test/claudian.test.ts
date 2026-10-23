import { describe, expect, it, vi } from "vitest";
import { buildSyncFixPrompt, openInClaudian, type ClaudianPluginLike } from "../src/workbench/claudian";

function deps(plugin: ClaudianPluginLike | null) {
  const copied: string[] = [];
  const notices: string[] = [];
  let missing = 0;
  return {
    deps: {
      getPlugin: () => plugin,
      copy: async (t: string) => {
        copied.push(t);
      },
      notify: (m: string) => {
        notices.push(m);
      },
      onMissing: () => {
        missing++;
      },
    },
    copied,
    notices,
    missing: () => missing,
  };
}

describe("openInClaudian", () => {
  it("opens the view, starts a new conversation and types the request in — without sending", async () => {
    const calls: string[] = [];
    const view = {
      startNewConversation: vi.fn(async () => {
        calls.push("new");
      }),
      appendToActiveInput: vi.fn((t: string) => {
        calls.push(`append:${t.slice(0, 7)}`);
        return true;
      }),
      focusActiveInput: vi.fn(() => {
        calls.push("focus");
      }),
    };
    const plugin: ClaudianPluginLike = {
      views: {
        activateView: async () => {
          calls.push("activate");
        },
        getView: () => view,
      },
    };
    const d = deps(plugin);
    expect(await openInClaudian(d.deps, "Covault — please fix")).toBe("prefilled");
    expect(calls).toEqual(["activate", "new", "append:Covault", "focus"]);
    expect(d.copied).toEqual([]);
  });

  it("falls back to the clipboard when any step is missing or refuses", async () => {
    const noInput = deps({ views: { activateView: async () => {}, getView: () => ({}) } });
    expect(await openInClaudian(noInput.deps, "P")).toBe("copied");
    expect(noInput.copied).toEqual(["P"]);
    expect(noInput.notices[0]).toMatch(/paste/);

    const refuses = deps({ views: { activateView: async () => {}, getView: () => ({ appendToActiveInput: () => false }) } });
    expect(await openInClaudian(refuses.deps, "P")).toBe("copied");

    const noViews = deps({});
    expect(await openInClaudian(noViews.deps, "P")).toBe("copied");

    const throws = deps({
      views: {
        activateView: async () => {
          throw new Error("boom");
        },
        getView: () => null,
      },
    });
    expect(await openInClaudian(throws.deps, "P")).toBe("copied");
  });

  it("says Claudian is missing instead of copying when the plugin isn't there", async () => {
    const d = deps(null);
    expect(await openInClaudian(d.deps, "P")).toBe("missing");
    expect(d.missing()).toBe(1);
    expect(d.copied).toEqual([]);
  });
});

describe("buildSyncFixPrompt", () => {
  it("names the folder, branch and error, and forbids history rewrites", () => {
    const p = buildSyncFixPrompt({
      vaultBase: "/Users/j/vault",
      repoPath: "teams/team-ccp-kb",
      label: "team-ccp-kb",
      branch: "main",
      error: "push failed: ECONNREFUSED",
    });
    expect(p).toContain("`/Users/j/vault/teams/team-ccp-kb`");
    expect(p).toContain("Branch: main");
    expect(p).toContain("ECONNREFUSED");
    expect(p).toMatch(/Never rebase, never force-push/);
    expect(p).not.toContain("GIT_DIR");
  });

  it("tells Claude about the personal knowledge base's separate git directory", () => {
    const p = buildSyncFixPrompt({
      vaultBase: "/v",
      repoPath: "",
      label: "Personal knowledge base",
      branch: "main",
      gitdir: "/v/.covault/main.git",
      error: "x",
    });
    expect(p).toContain('GIT_DIR="/v/.covault/main.git" GIT_WORK_TREE="/v"');
  });
});
