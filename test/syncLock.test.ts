/**
 * The lock is per repo, not global. Two libraries are separate working
 * trees with separate git directories, so making one wait for the other
 * only broke the panel's per-row button. The same repo twice is the case
 * that must not happen: one index, one working tree.
 */
import { describe, expect, it, vi } from "vitest";
import { SyncController, type SyncItem } from "../src/sync/SyncController";
import type { GitEngine, SyncResult } from "../src/git/GitEngine";

function items(...paths: string[]): SyncItem[] {
  return paths.map((p) => ({ path: p, url: `https://github.com/o/${p || "main"}.git`, branch: "main" }));
}

/** An engine whose rounds block until released, so overlap is observable. */
function pausableEngine() {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const engine = {
    isRepo: async () => true,
    syncToRemote: (ref: { dir: string }) => {
      const key = ref.dir;
      started.push(key);
      return new Promise<SyncResult>((resolve) => {
        release.set(key, () => resolve({ committed: [], pulled: false, pushed: false, conflictFilepaths: [] }));
      });
    },
  } as unknown as GitEngine;
  return { engine, started, releaseAll: () => release.forEach((fn) => fn()), release };
}

function controller(engine: GitEngine, repos: SyncItem[]) {
  return new SyncController(engine, {
    vaultBasePath: () => "/vault",
    repos: () => repos,
    onStateChange: () => {},
  });
}

describe("per-repo sync locking", () => {
  it("runs two different repos at the same time", async () => {
    const { engine, started, releaseAll } = pausableEngine();
    const sync = controller(engine, items("lib-a", "lib-b"));
    const a = sync.syncJust("lib-a");
    const b = sync.syncJust("lib-b");
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(sync.isSyncing("lib-a")).toBe(true);
    expect(sync.isSyncing("lib-b")).toBe(true);
    releaseAll();
    await Promise.all([a, b]);
  });

  it("refuses a second round of the same repo, joining the first instead", async () => {
    const { engine, started, releaseAll } = pausableEngine();
    const sync = controller(engine, items("lib-a"));
    const first = sync.syncJust("lib-a");
    const second = sync.syncJust("lib-a");
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started).toEqual(["/vault/lib-a"]); // not started twice
    releaseAll();
    await Promise.all([first, second]);
  });

  it("releases the lock when the round finishes", async () => {
    const { engine, started, releaseAll } = pausableEngine();
    const sync = controller(engine, items("lib-a"));
    const round = sync.syncJust("lib-a");
    expect(sync.isSyncing("lib-a")).toBe(true);
    // Wait for the round to reach the pausable call, or there is nothing
    // to release yet and it would hang.
    await vi.waitFor(() => expect(started).toHaveLength(1));
    releaseAll();
    await round;
    expect(sync.isSyncing("lib-a")).toBe(false);
  });

  it("releases the lock even when the round throws", async () => {
    const engine = {
      isRepo: async () => true,
      syncToRemote: async () => {
        throw new Error("network gone");
      },
    } as unknown as GitEngine;
    const sync = controller(engine, items("lib-a"));
    await sync.syncJust("lib-a");
    expect(sync.isSyncing("lib-a")).toBe(false);
    expect(sync.state("lib-a")).toMatchObject({ phase: "error", detail: "network gone" });
  });

  it("a full pass skips a repo that is already syncing on its own", async () => {
    const { engine, started, releaseAll } = pausableEngine();
    const sync = controller(engine, items("lib-a", "lib-b"));
    const single = sync.syncJust("lib-a");
    await vi.waitFor(() => expect(started).toEqual(["/vault/lib-a"]));
    const pass = sync.syncAll("auto");
    await vi.waitFor(() => expect(started).toContain("/vault/lib-b"));
    // lib-a was not started a second time by the pass.
    expect(started.filter((s) => s.endsWith("lib-a"))).toHaveLength(1);
    releaseAll();
    await Promise.all([single, pass]);
  });

  it("keys the personal repo by its empty path, distinct from any library", async () => {
    const { engine, started, releaseAll } = pausableEngine();
    const sync = controller(engine, items("", "lib-a"));
    const personal = sync.syncJust("");
    const lib = sync.syncJust("lib-a");
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(sync.isSyncing("")).toBe(true);
    releaseAll();
    await Promise.all([personal, lib]);
  });
});

/**
 * The panel needs to name what is running and for how long: a sweep
 * working through fifteen libraries looked identical to a stuck one.
 */
describe("what the panel can see", () => {
  it("lists nothing while idle", () => {
    const { engine } = pausableEngine();
    const sync = controller(engine, items("lib-a"));
    expect(sync.activeTasks()).toEqual([]);
    expect(sync.isSweeping()).toBe(false);
  });

  it("names each running round, oldest first, with a start time", async () => {
    const { engine, started, releaseAll } = pausableEngine();
    const repos: SyncItem[] = [
      { path: "", url: "u", branch: "main", label: "Personal knowledge base" },
      { path: "lib-a", url: "u", branch: "main" },
    ];
    const sync = controller(engine, repos);
    const a = sync.syncJust("");
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const b = sync.syncJust("lib-a");
    await vi.waitFor(() => expect(started).toHaveLength(2));
    const tasks = sync.activeTasks();
    // Falls back to the path when there is no label, and keeps order.
    expect(tasks.map((t) => t.label)).toEqual(["Personal knowledge base", "lib-a"]);
    expect(tasks[0]!.startedAt).toBeLessThanOrEqual(tasks[1]!.startedAt);
    releaseAll();
    await Promise.all([a, b]);
    expect(sync.activeTasks()).toEqual([]);
  });

  it("reports a sweep as a sweep", async () => {
    const { engine, started, releaseAll } = pausableEngine();
    const sync = controller(engine, items("lib-a"));
    const pass = sync.syncAll("auto");
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(sync.isSweeping()).toBe(true);
    releaseAll();
    await pass;
    expect(sync.isSweeping()).toBe(false);
  });
})
