// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { classify } from "./load.ts";
import { declaredTools, serverEntryPoint, diffTools } from "./mcp-local-parity.ts";
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
