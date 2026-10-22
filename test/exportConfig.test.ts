import { describe, expect, it } from "vitest";
import { buildConfigExport, parseConfigImport, planConfigImport } from "../src/covault/exportConfig";
import { DEFAULT_SETTINGS, isSignedIn, type CovaultSettings } from "../src/settings";
import type { CovaultManifest } from "../src/covault/manifest";

function settings(): CovaultSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    githubToken: "ghp_SECRET",
    deviceId: "DEVICE_SECRET",
    githubApp: { connections: [{ sessionId: "SESSION_SECRET", login: "jakob", installations: [] }] },
    llmKeys: { anthropic: "sk-SECRET" },
    author: { name: "Jakob", email: "j@x.com" },
    llm: { provider: "anthropic", model: "claude-sonnet-5" },
    mainRepo: { url: "https://github.com/ct-kb/personal-kb-jakob.git", branch: "main" },
  };
}

const manifest: CovaultManifest = {
  version: 1,
  scope: "vault",
  include: ["notes"],
  repos: [
    { path: "Z01/team-ccp-kb", url: "https://github.com/ct-kb/team-ccp-kb.git", branch: "main", description: "CCP" },
    { path: "Z01/team-oms-kb", url: "https://github.com/ct-kb/team-oms-kb.git", branch: "main" },
  ],
};

describe("buildConfigExport", () => {
  it("carries every setting a teammate needs to reproduce the setup", () => {
    const out = JSON.parse(JSON.stringify(buildConfigExport(settings(), manifest)));
    expect(out.covaultExport).toBe(4);
    // No organization travels with a setup: it is picked per library.
    expect(out.settings).not.toHaveProperty("baseOrg");
    expect(out.settings.llm).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(out.settings).not.toHaveProperty("ask");
    expect(out.settings.personalKb.url).toContain("personal-kb-jakob");
    expect(out.personalKbScope).toEqual({ scope: "vault", include: ["notes"] });
    expect(out.libraries).toHaveLength(2);
    expect(out.libraries[0].description).toBe("CCP");
    expect(out.libraries[1]).not.toHaveProperty("description");
  });

  it("never leaks a secret", () => {
    const text = JSON.stringify(buildConfigExport(settings(), manifest));
    for (const secret of ["ghp_SECRET", "DEVICE_SECRET", "SESSION_SECRET", "sk-SECRET"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("the export leaves personal identity out", () => {
  it("carries no name or email, in any shape", () => {
    const out = buildConfigExport(settings(), manifest);
    const text = JSON.stringify(out);
    expect(text).not.toContain("Jakob");
    expect(text).not.toContain("j@x.com");
    expect((out as { settings: Record<string, unknown> }).settings).not.toHaveProperty("author");
  });
});

describe("parseConfigImport", () => {
  it("accepts a current export", () => {
    const text = JSON.stringify(buildConfigExport(settings(), manifest));
    expect(parseConfigImport(text).covaultExport).toBe(4);
  });

  it("rejects text that isn't JSON", () => {
    expect(() => parseConfigImport("not json at all")).toThrow(/valid JSON/);
  });

  it("rejects JSON that isn't a Covault export", () => {
    expect(() => parseConfigImport('{"hello": 1}')).toThrow(/covaultExport/);
    expect(() => parseConfigImport("[1,2,3]")).toThrow(/Covault configuration/);
  });

  it("refuses a format from a newer Covault", () => {
    expect(() => parseConfigImport('{"covaultExport": 99}')).toThrow(/newer Covault/);
  });

  it("still reads a v1 file (which carried an author)", () => {
    expect(parseConfigImport('{"covaultExport": 1, "settings": {}}').covaultExport).toBe(1);
  });
});

describe("planConfigImport", () => {
  /** A vault with nothing set up: every incoming value is a change. */
  function blank(): CovaultSettings {
    return structuredClone(DEFAULT_SETTINGS);
  }
  const empty: CovaultManifest = { version: 1, scope: "marked", include: [], repos: [] };
  const file = () => JSON.parse(JSON.stringify(buildConfigExport(settings(), manifest)));

  it("lists each field that would change, with both values", () => {
    const plan = planConfigImport(blank(), empty, file());
    const model = plan.changes.find((c) => c.key === "llmModel");
    expect(model).toMatchObject({ from: "(empty)", to: "claude-sonnet-5", value: "claude-sonnet-5" });
    expect(plan.changes.find((c) => c.key === "syncAuto")).toBeUndefined(); // same as the default
  });

  it("says nothing about fields that already match", () => {
    const same = { ...blank(), llm: { provider: "anthropic", model: "claude-sonnet-5" } };
    const plan = planConfigImport(same, empty, file());
    expect(plan.changes.find((c) => c.key === "llmModel")).toBeUndefined();
  });

  it("adds only libraries this vault doesn't have", () => {
    const plan = planConfigImport(blank(), { ...empty, repos: [manifest.repos[0]!] }, file());
    expect(plan.newLibraries.map((r) => r.path)).toEqual(["Z01/team-oms-kb"]);
    expect(plan.existingLibraries).toBe(1);
  });

  it("never imports identity, the personal KB, or the sign-in method", () => {
    const raw = file();
    raw.settings.author = { name: "Someone Else", email: "them@example.com" };
    raw.settings.authMethod = "pat";
    const plan = planConfigImport(blank(), empty, raw);
    expect(JSON.stringify(plan.changes)).not.toContain("Someone Else");
    expect(JSON.stringify(plan.changes)).not.toContain("them@example.com");
    expect(plan.changes.some((c) => (c.key as string) === "authMethod")).toBe(false);
    const why = plan.skipped.join(" ");
    expect(why).toContain("name and email");
    expect(why).toContain("personal knowledge base");
    expect(why).toContain("sign-in method");
  });

  it("takes the personal-notes scope but not the exporter's note paths", () => {
    const plan = planConfigImport(blank(), empty, file());
    expect(plan.changes.find((c) => c.key === "personalKbScope")).toMatchObject({ from: "marked", to: "vault" });
    expect(plan.skipped.join(" ")).toContain("individually shared notes");
  });

  it("ignores the Ask settings an older (v3) export still carries", () => {
    const raw = { ...file(), covaultExport: 3 };
    raw.settings.ask = { requireApproval: false, mcpServers: "{}", cliHints: "x" };
    const plan = planConfigImport(blank(), empty, raw);
    expect(plan.changes.some((c) => (c.key as string).startsWith("ask"))).toBe(false);
  });

  it("survives a file with junk where the sections should be", () => {
    const plan = planConfigImport(blank(), empty, {
      covaultExport: 3,
      settings: { llm: "nope", sync: null },
      libraries: [null, "x", { path: "ok" }, { path: "p", url: "u" }],
    });
    expect(plan.changes.find((c) => c.key === "llmProvider")).toBeUndefined();
    expect(plan.newLibraries).toEqual([{ path: "p", url: "u", branch: "main" }]);
  });
});

describe("importing needs GitHub access", () => {
  /** applyConfigImport refuses before touching anything, because every
   *  library in the plan has to be fetched from GitHub. */
  function plugin(over: Partial<CovaultSettings>): CovaultSettings {
    return { ...structuredClone(DEFAULT_SETTINGS), ...over };
  }

  it("counts a GitHub App connection as signed in", () => {
    expect(isSignedIn(plugin({ githubApp: { connections: [{ sessionId: "s", login: "me", installations: [] }] } }))).toBe(
      true,
    );
  });

  it("counts a non-blank PAT as signed in", () => {
    expect(isSignedIn(plugin({ authMethod: "pat", githubToken: "ghp_x" }))).toBe(true);
    expect(isSignedIn(plugin({ authMethod: "pat", githubToken: "   " }))).toBe(false);
  });

  it("is not signed in with neither", () => {
    expect(isSignedIn(plugin({}))).toBe(false);
    // A PAT is irrelevant while the App is the selected method.
    expect(isSignedIn(plugin({ authMethod: "githubApp", githubToken: "ghp_x" }))).toBe(false);
  });
});
