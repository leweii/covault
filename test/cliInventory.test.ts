import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type MutableModels } from "@earendil-works/pi-ai";
import {
  CliInventory,
  detectCliContext,
  detectClis,
  renderCliManifest,
  resolveShellPath,
  type CliProbeHost,
} from "../src/llm/cliInventory";
import { AskEngine } from "../src/llm/ask";

/** A machine with a known PATH, a known set of installed CLIs, and a
 *  login shell that prints rc-file noise before its PATH (as they do). */
function fakeHost(opts: {
  installed?: string[];
  loginPath?: string | null;
  existingDirs?: string[];
  basePath?: string;
  calls?: string[];
} = {}): CliProbeHost {
  const installed = new Set(opts.installed ?? []);
  return {
    platform: "darwin",
    shell: "/bin/zsh",
    baseEnv: { PATH: opts.basePath ?? "/usr/bin:/bin", HOME: "/Users/x" },
    homedir: "/Users/x",
    dirExists: (dir) => (opts.existingDirs ?? []).includes(dir),
    sh: async (command, env) => {
      opts.calls?.push(command);
      if (command.includes("COVAULT_PATH")) {
        return opts.loginPath === null ? "" : `Welcome back!\nCOVAULT_PATH=${opts.loginPath ?? "/opt/homebrew/bin:/usr/bin:/bin"}`;
      }
      if (command.startsWith("gcloud config list")) return "me@corp.com \u00b7 default project sandbox-proj\n";
      if (command.startsWith("aws configure list")) return "";
      if (command.startsWith("kubectl config")) return "prod-cluster\n";
      // The probe only finds tools reachable from the PATH it was given.
      const reachable = (env.PATH ?? "").includes("/opt/homebrew/bin");
      const names = [...command.matchAll(/for n in ([^;]+);/g)][0]?.[1]?.split(" ") ?? [];
      return names.filter((n) => installed.has(n) && (reachable || n === "git")).join("\n");
    },
  };
}

describe("resolveShellPath", () => {
  it("prefers the login shell's PATH, ignoring rc-file chatter", async () => {
    const path = await resolveShellPath(fakeHost({ loginPath: "/opt/homebrew/bin:/usr/bin" }));
    expect(path.split(":")[0]).toBe("/opt/homebrew/bin");
    // The inherited PATH is kept as a fallback tail, without duplicates.
    expect(path.split(":").filter((d) => d === "/usr/bin")).toHaveLength(1);
    expect(path).toContain("/bin");
  });

  it("falls back to the inherited PATH plus the install dirs that exist", async () => {
    const path = await resolveShellPath(
      fakeHost({ loginPath: null, existingDirs: ["/opt/homebrew/bin", "/Users/x/google-cloud-sdk/bin"] }),
    );
    expect(path.startsWith("/usr/bin:/bin")).toBe(true);
    expect(path).toContain("/opt/homebrew/bin");
    expect(path).toContain("/Users/x/google-cloud-sdk/bin");
    // Dirs that don't exist are not advertised.
    expect(path).not.toContain("/Users/x/.cargo/bin");
  });
});

describe("detectClis", () => {
  it("reports only what the machine has", async () => {
    const host = fakeHost({ installed: ["bq", "gcloud", "jq", "git"] });
    const found = await detectClis(host, { PATH: "/opt/homebrew/bin" });
    expect(found).toContain("bq");
    expect(found).toContain("jq");
    expect(found).not.toContain("psql");
  });
});

describe("detectCliContext", () => {
  it("reports what each detected tool is pointed at, and skips the silent ones", async () => {
    const host = fakeHost({ installed: ["bq", "aws", "kubectl", "jq"] });
    const context = await detectCliContext(host, { PATH: "/opt/homebrew/bin" }, ["bq", "aws", "kubectl", "jq"]);
    expect(context.bq).toContain("sandbox-proj");
    expect(context.kubectl).toBe("prod-cluster");
    expect(context.aws).toBeUndefined(); // nothing to say → no line
    expect(context.jq).toBeUndefined(); // no context probe at all
  });

  it("only probes tools that are actually installed", async () => {
    const calls: string[] = [];
    const host = fakeHost({ installed: ["jq"], calls });
    await detectCliContext(host, { PATH: "/opt/homebrew/bin" }, ["jq"]);
    expect(calls).toHaveLength(0);
  });
});

describe("renderCliManifest", () => {
  it("names each tool with a hint on when to use it", () => {
    const text = renderCliManifest({ platform: "darwin", cwd: "/vault", found: ["bq", "jq"] })!;
    expect(text).toContain("bq — ");
    expect(text).toContain("--use_legacy_sql=false");
    expect(text).toContain("/vault");
    // Absent tools are never advertised, but the model is told to check.
    expect(text).not.toContain("psql");
    expect(text).toContain("command -v");
  });

  it("shows the default project and how to override it — the 403 that started this", () => {
    const text = renderCliManifest({
      platform: "darwin",
      cwd: "/vault",
      found: ["bq"],
      context: { bq: "me@corp.com \u00b7 default project sandbox-proj" },
    })!;
    // The model must see that the default is *a* project, not *the* project…
    expect(text).toContain("default project sandbox-proj");
    // …and know the escape hatch when the data lives elsewhere.
    expect(text).toContain("--project_id");
    expect(text).toContain("not a wall");
  });

  it("carries the user's own declarations", () => {
    const text = renderCliManifest({
      platform: "darwin",
      cwd: "/vault",
      found: [],
      declared: "mycli — internal deploy tool",
    })!;
    expect(text).toContain("mycli — internal deploy tool");
  });

  it("says nothing when there is nothing to say", () => {
    expect(renderCliManifest({ platform: "darwin", cwd: "/vault", found: [] })).toBeNull();
  });
});

describe("CliInventory", () => {
  it("probes once, exposes the resolved env, and re-probes after refresh", async () => {
    const calls: string[] = [];
    const inventory = new CliInventory({
      cwd: () => "/vault",
      declared: () => "",
      host: fakeHost({ installed: ["bq", "git"], calls }),
    });
    // Before the first probe the tool env is simply what we inherited.
    expect(inventory.env().PATH).toBe("/usr/bin:/bin");

    const first = await inventory.manifest();
    expect(first).toContain("bq — ");
    expect(inventory.env().PATH).toContain("/opt/homebrew/bin");
    const afterFirst = calls.length;

    await inventory.manifest();
    expect(calls.length).toBe(afterFirst); // cached

    inventory.refresh();
    await inventory.manifest();
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it("survives a machine it can't probe", async () => {
    const host: CliProbeHost = { ...fakeHost(), sh: async () => { throw new Error("no shell here"); } };
    const inventory = new CliInventory({ cwd: () => "/vault", declared: () => "", host });
    expect(await inventory.manifest()).toBeNull();
    expect(inventory.env().PATH).toBe("/usr/bin:/bin");
  });
});

describe("the real machine", () => {
  // The fake host can't reproduce shell exit codes, and that is exactly
  // where this broke: a final `command -v` miss makes the probe script
  // exit non-zero, and treating that as failure threw away every hit.
  it("detects the CLIs that are actually installed", async () => {
    const inventory = new CliInventory({ cwd: () => process.cwd(), declared: () => "" });
    const text = await inventory.manifest();
    expect(text).toContain("git — "); // running from a git checkout
    expect(inventory.env().PATH).toBeTruthy();
  }, 30_000);
});

describe("the agent is told what it can run", () => {
  it("puts the CLI manifest in the system prompt", async () => {
    const seen: Context[] = [];
    const models = {
      getModel: () => ({ id: "fake", api: "fake", provider: "fake" }),
      streamSimple: (_model: unknown, context: Context) => {
        seen.push(context);
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: "fake" as never,
          provider: "fake",
          model: "fake",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } as never,
          stopReason: "stop",
          timestamp: 0,
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
          stream.push({ type: "done", reason: "stop" as never, message });
        });
        return stream;
      },
    } as unknown as MutableModels;

    const inventory = new CliInventory({
      cwd: () => "/vault",
      declared: () => "mycli — internal deploy tool",
      host: fakeHost({ installed: ["bq", "gcloud"] }),
    });
    const ask = new AskEngine({
      models,
      getSelection: () => ({ provider: "fake", model: "fake" }),
      hasKey: () => true,
      requireApproval: () => true,
      tools: async () => [],
      libraryMap: () => "## ccp-kb — refunds",
      cliManifest: () => inventory.manifest(),
    });
    await ask.ask("怎么分析上周的退款数据？");
    const prompt = seen[0]?.systemPrompt ?? "";
    expect(prompt).toContain("=== Library map ===");
    expect(prompt).toContain("bq — ");
    expect(prompt).toContain("mycli — internal deploy tool");
  });
});
