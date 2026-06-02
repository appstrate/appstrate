// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { classify } from "./load.ts";
import { declaredTools, serverEntryPoint, diffTools } from "./mcp-local-parity.ts";
import { diffToolSets } from "./tool-diff.ts";
import { resolveToken, credentialedCount, _resetCredsCache } from "./creds.ts";
import { remoteUrl, toolsPolicyKeys, allowsUndeclared } from "./remote-parity.ts";
import { summarize, exitCode, formatReport } from "./report.ts";
import type { Finding } from "./types.ts";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";

function entry(partial: Partial<SystemPackageEntry>): SystemPackageEntry {
  return {
    packageId: "@appstrate/x",
    scope: "@appstrate",
    name: "x",
    type: "integration",
    version: "1.0.0",
    manifest: {},
    zipBuffer: Buffer.alloc(0),
    content: "",
    files: {},
    ...partial,
  };
}

describe("classify", () => {
  it("maps mcp-server to local", () => {
    expect(classify(entry({ type: "mcp-server" }))).toBe("mcp-server-local");
  });

  it("maps remote integration to mcp-remote", () => {
    expect(classify(entry({ type: "integration", manifest: { source: { kind: "remote" } } }))).toBe(
      "mcp-remote",
    );
  });

  it("maps source.kind none (and missing source) to integration-cred", () => {
    expect(classify(entry({ type: "integration", manifest: { source: { kind: "none" } } }))).toBe(
      "integration-cred",
    );
    expect(classify(entry({ type: "integration", manifest: {} }))).toBe("integration-cred");
  });

  it("maps agents/skills to other", () => {
    expect(classify(entry({ type: "agent" }))).toBe("other");
    expect(classify(entry({ type: "skill" }))).toBe("other");
  });
});

describe("declaredTools / serverEntryPoint", () => {
  it("extracts tool names, skipping malformed entries", () => {
    const manifest = { tools: [{ name: "clone" }, { name: "status" }, { notName: 1 }, "bad"] };
    expect(declaredTools(manifest)).toEqual(["clone", "status"]);
  });

  it("returns [] when tools is absent or not an array", () => {
    expect(declaredTools({})).toEqual([]);
    expect(declaredTools({ tools: "nope" })).toEqual([]);
  });

  it("reads server.entry_point", () => {
    expect(serverEntryPoint({ server: { entry_point: "server/index.ts" } })).toBe(
      "server/index.ts",
    );
    expect(serverEntryPoint({ server: {} })).toBeUndefined();
    expect(serverEntryPoint({})).toBeUndefined();
  });
});

describe("diffTools", () => {
  const id = "@appstrate/github-git-mcp";

  it("returns no findings on exact parity", () => {
    expect(diffTools(id, ["clone", "status"], ["clone", "status"])).toEqual([]);
  });

  it("ignores ordering differences", () => {
    expect(diffTools(id, ["a", "b"], ["b", "a"])).toEqual([]);
  });

  it("fails on a declared tool the server does not expose", () => {
    const f = diffTools(id, ["clone", "ghost"], ["clone"]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("fail");
    expect(f[0]!.message).toContain("ghost");
  });

  it("fails on a server tool not declared in the manifest", () => {
    const f = diffTools(id, ["clone"], ["clone", "surprise"]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("fail");
    expect(f[0]!.message).toContain("surprise");
  });

  it("reports both directions at once", () => {
    const f = diffTools(id, ["a", "missing"], ["a", "extra"]);
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.severity === "fail")).toBe(true);
  });
});

describe("report", () => {
  const findings: Finding[] = [
    { packageId: "@a/p", check: "c", severity: "info", message: "ok" },
    { packageId: "@a/p", check: "c", severity: "fail", message: "bad" },
    { packageId: "@a/p", check: "c", severity: "warn", message: "meh" },
  ];

  it("summarizes counts and ok flag", () => {
    const s = summarize(findings);
    expect(s).toMatchObject({ fail: 1, warn: 1, info: 1, total: 3, ok: false });
    expect(summarize([findings[0]!]).ok).toBe(true);
  });

  it("exit code is 1 with any fail, else 0", () => {
    expect(exitCode(findings)).toBe(1);
    expect(exitCode([findings[0]!])).toBe(0);
    expect(exitCode([])).toBe(0);
  });

  it("orders findings fail → warn → info within a package", () => {
    const out = formatReport(findings);
    expect(out.indexOf("bad")).toBeLessThan(out.indexOf("meh"));
    expect(out.indexOf("meh")).toBeLessThan(out.indexOf("ok"));
  });

  it("handles the empty case", () => {
    expect(formatReport([])).toContain("nothing to check");
  });
});

describe("diffToolSets — allowUndeclared", () => {
  const id = "@appstrate/github-mcp";

  it("FAILs on undeclared server tools when strict", () => {
    const f = diffToolSets(id, ["a"], ["a", "extra"], { check: "c", allowUndeclared: false });
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("fail");
  });

  it("WARNs (not FAILs) on undeclared server tools when allowed", () => {
    const f = diffToolSets(id, ["a"], ["a", "extra"], { check: "c", allowUndeclared: true });
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
    expect(f[0]!.message).toContain("extra");
  });

  it("still FAILs on a declared tool the server lacks, even when allowUndeclared", () => {
    const f = diffToolSets(id, ["a", "gone"], ["a", "extra"], {
      check: "c",
      allowUndeclared: true,
    });
    const missing = f.find((x) => x.message.includes("gone"));
    const extra = f.find((x) => x.message.includes("extra"));
    expect(missing!.severity).toBe("fail");
    expect(extra!.severity).toBe("warn");
  });
});

describe("creds", () => {
  afterEach(() => {
    delete process.env.CONFORMANCE_TOKENS;
    _resetCredsCache();
  });

  it("resolves a token from the JSON map", () => {
    process.env.CONFORMANCE_TOKENS = JSON.stringify({ "@appstrate/clickup-mcp": "tok123" });
    _resetCredsCache();
    expect(resolveToken("@appstrate/clickup-mcp")).toBe("tok123");
    expect(resolveToken("@appstrate/notion-mcp")).toBeUndefined();
    expect(credentialedCount()).toBe(1);
  });

  it("returns undefined for everything when env is absent or invalid", () => {
    _resetCredsCache();
    expect(resolveToken("@appstrate/clickup-mcp")).toBeUndefined();
    expect(credentialedCount()).toBe(0);

    process.env.CONFORMANCE_TOKENS = "not json{";
    _resetCredsCache();
    expect(resolveToken("@appstrate/clickup-mcp")).toBeUndefined();
  });

  it("skips non-string / empty values", () => {
    process.env.CONFORMANCE_TOKENS = JSON.stringify({ a: "", b: 5, c: "ok" });
    _resetCredsCache();
    expect(credentialedCount()).toBe(1);
    expect(resolveToken("c")).toBe("ok");
  });
});

describe("remote manifest accessors", () => {
  it("reads source.remote.url", () => {
    expect(remoteUrl({ source: { kind: "remote", remote: { url: "https://x/mcp" } } })).toBe(
      "https://x/mcp",
    );
    expect(remoteUrl({ source: { kind: "none" } })).toBeUndefined();
    expect(remoteUrl({})).toBeUndefined();
  });

  it("reads tools_policy keys", () => {
    expect(toolsPolicyKeys({ tools_policy: { create_task: {}, get_task: {} } }).sort()).toEqual([
      "create_task",
      "get_task",
    ]);
    expect(toolsPolicyKeys({})).toEqual([]);
    expect(toolsPolicyKeys({ tools_policy: [] })).toEqual([]);
  });

  it("reads allow_undeclared_tools", () => {
    expect(allowsUndeclared({ allow_undeclared_tools: true })).toBe(true);
    expect(allowsUndeclared({ allow_undeclared_tools: false })).toBe(false);
    expect(allowsUndeclared({})).toBe(false);
  });
});
