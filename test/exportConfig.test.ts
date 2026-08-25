import { describe, expect, it } from "vitest";
import { buildConfigExport, parseConfigImport, planConfigImport, redactMcpConfig } from "../src/covault/exportConfig";
import { DEFAULT_SETTINGS, type CovaultSettings } from "../src/settings";
import type { CovaultManifest } from "../src/covault/manifest";

function settings(): CovaultSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    githubToken: "ghp_SECRET",
    deviceId: "DEVICE_SECRET",
    githubApp: { connections: [{ sessionId: "SESSION_SECRET", login: "jakob", installations: [] }] },
    llmKeys: { anthropic: "sk-SECRET" },
    baseOrg: "ct-kb",
    author: { name: "Jakob", email: "j@x.com" },
    llm: { provider: "anthropic", model: "claude-sonnet-5" },
    ask: {
      requireApproval: false,
      mcpServers: '{"mcpServers": {"jira": {"command": "npx", "env": {"JIRA_TOKEN": "tok_SECRET"}}}}',
      cliHints: "mycli — internal deploy tool",
    },
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
    expect(out.covaultExport).toBe(2);
    expect(out.settings.baseOrg).toBe("ct-kb");
    expect(out.settings.llm).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(out.settings.ask.requireApproval).toBe(false);
    expect(out.settings.personalKb.url).toContain("personal-kb-jakob");
    expect(out.personalKbScope).toEqual({ scope: "vault", include: ["notes"] });
    expect(out.libraries).toHaveLength(2);
    expect(out.libraries[0].description).toBe("CCP");
    expect(out.libraries[1]).not.toHaveProperty("description");
  });

  it("never leaks a secret, even via the MCP env", () => {
    const text = JSON.stringify(buildConfigExport(settings(), manifest));
    for (const secret of ["ghp_SECRET", "DEVICE_SECRET", "SESSION_SECRET", "sk-SECRET", "tok_SECRET"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("JIRA_TOKEN"); // the key survives, the value doesn't
    expect(text).toContain("«redacted»");
  });
});

describe("redactMcpConfig", () => {
  it("masks env values in every config shape", () => {
    expect(redactMcpConfig('[{"name": "a", "command": "x", "env": {"T": "s3cret"}}]')).not.toContain("s3cret");
    expect(redactMcpConfig('{"direct": {"url": "https://x", "env": {"K": "v"}}}')).not.toContain('"v"');
  });

  it("passes empty and invalid JSON through untouched", () => {
    expect(redactMcpConfig("")).toBe("");
    expect(redactMcpConfig("{half-typed")).toBe("{half-typed");
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
    expect(parseConfigImport(text).covaultExport).toBe(2);
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
    const org = plan.changes.find((c) => c.key === "baseOrg");
    expect(org).toMatchObject({ from: "(empty)", to: "ct-kb", value: "ct-kb" });
    expect(plan.changes.find((c) => c.key === "llmModel")?.to).toBe("claude-sonnet-5");
    expect(plan.changes.find((c) => c.key === "askApprove")).toMatchObject({ from: "true", to: "false" });
  });

  it("says nothing about fields that already match", () => {
    const same = { ...blank(), baseOrg: "ct-kb" };
    const plan = planConfigImport(same, empty, file());
    expect(plan.changes.find((c) => c.key === "baseOrg")).toBeUndefined();
  });

  it("adds only libraries this vault doesn't have", () => {
    const plan = planConfigImport(blank(), { ...empty, repos: [manifest.repos[0]!] }, file());
    expect(plan.newLibraries.map((r) => r.path)).toEqual(["Z01/team-oms-kb"]);
    expect(plan.existingLibraries).toBe(1);
  });

  it("refuses the MCP config, because the export masked its tokens", () => {
    const plan = planConfigImport(blank(), empty, file());
    expect(plan.changes.find((c) => c.key === "askMcp")).toBeUndefined();
    expect(plan.skipped.join(" ")).toContain("MCP");
  });

  it("imports an MCP config that carries no masked values", () => {
    const raw = file();
    raw.settings.ask.mcpServers = '{"mcpServers":{"docs":{"command":"npx"}}}';
    const plan = planConfigImport(blank(), empty, raw);
    expect(plan.changes.find((c) => c.key === "askMcp")?.to).toContain("docs");
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

  it("survives a file with junk where the sections should be", () => {
    const plan = planConfigImport(blank(), empty, {
      covaultExport: 2,
      settings: { baseOrg: 42, llm: "nope", sync: null },
      libraries: [null, "x", { path: "ok" }, { path: "p", url: "u" }],
    });
    expect(plan.changes.find((c) => c.key === "baseOrg")).toBeUndefined();
    expect(plan.newLibraries).toEqual([{ path: "p", url: "u", branch: "main" }]);
  });
});
