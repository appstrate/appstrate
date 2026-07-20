// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { classify } from "./load.ts";
import { declaredTools, serverEntryPoint, serverRuntime, diffTools } from "./mcp-local-parity.ts";
import { diffToolSets } from "./tool-diff.ts";
import { resolveToken, resolveAccessToken, credentialedCount, _resetCredsCache } from "./creds.ts";
import { remoteUrl, toolsPolicyKeys, allowsUndeclared } from "./remote-parity.ts";
import { applyAuth, checkAuthLiveness } from "./auth-live.ts";
import { listAllTools } from "./mcp-list.ts";
import { snapshotSlug, writeSnapshot, readSnapshot } from "./snapshot.ts";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
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

  it("reads only the Appstrate MCP runtime override", () => {
    expect(
      serverRuntime({ _meta: { "dev.appstrate/mcp-server": { runtime: "browser-use" } } }),
    ).toBe("browser-use");
    expect(serverRuntime({ _meta: { runtime: "browser-use" } })).toBeUndefined();
    expect(serverRuntime({})).toBeUndefined();
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

  it("counts refresh-credential entries; resolveToken returns only strings", () => {
    process.env.CONFORMANCE_TOKENS = JSON.stringify({
      a: "tok",
      b: { refresh_token: "r", client_id: "c" },
      bad: { refresh_token: "r" }, // missing client_id → dropped
    });
    _resetCredsCache();
    expect(credentialedCount()).toBe(2);
    expect(resolveToken("a")).toBe("tok");
    expect(resolveToken("b")).toBeUndefined();
  });
});

describe("resolveAccessToken", () => {
  afterEach(() => {
    delete process.env.CONFORMANCE_TOKENS;
    _resetCredsCache();
  });

  it("returns a plain-string credential as-is", async () => {
    process.env.CONFORMANCE_TOKENS = JSON.stringify({ "@x/p": "ya29" });
    _resetCredsCache();
    expect(await resolveAccessToken(entry({ packageId: "@x/p" }))).toBe("ya29");
  });

  it("returns undefined when no credential is configured", async () => {
    _resetCredsCache();
    expect(await resolveAccessToken(entry({ packageId: "@x/p" }))).toBeUndefined();
  });

  it("mints + caches a fresh token from a refresh credential", async () => {
    process.env.CONFORMANCE_TOKENS = JSON.stringify({
      "@x/p": {
        refresh_token: "r",
        client_id: "cid",
        client_secret: "s",
        token_endpoint_auth_method: "client_secret_post",
        token_endpoint: "https://t/token",
      },
    });
    _resetCredsCache();
    let calls = 0;
    const exchange = (async () => {
      calls++;
      return { raw: { access_token: "fresh" }, parsed: {} };
    }) as never;
    const e = entry({ packageId: "@x/p" });
    expect(await resolveAccessToken(e, { exchange })).toBe("fresh");
    expect(await resolveAccessToken(e, { exchange })).toBe("fresh"); // cached
    expect(calls).toBe(1);
  });

  it("throws when a refresh credential has no token_endpoint and no manifest issuer", async () => {
    process.env.CONFORMANCE_TOKENS = JSON.stringify({
      "@x/p": { refresh_token: "r", client_id: "cid" },
    });
    _resetCredsCache();
    await expect(resolveAccessToken(entry({ packageId: "@x/p", manifest: {} }))).rejects.toThrow(
      /token_endpoint or a manifest issuer/,
    );
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

describe("applyAuth", () => {
  const headerManifest = {
    auths: {
      primary: { delivery: { http: { in: "header", name: "Authorization", prefix: "Bearer" } } },
    },
  };

  it("sets a Bearer header with a single space, regardless of prefix spacing", () => {
    const { headers } = applyAuth("https://api/x", headerManifest, "tok", "primary");
    expect(headers.Authorization).toBe("Bearer tok");

    const spaced = {
      auths: { primary: { delivery: { http: { name: "Authorization", prefix: "Bearer " } } } },
    };
    expect(applyAuth("https://api/x", spaced, "tok", "primary").headers.Authorization).toBe(
      "Bearer tok",
    );
  });

  it("falls back to Bearer Authorization when no delivery declared", () => {
    const { headers } = applyAuth("https://api/x", {}, "tok", "primary");
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("delivers via query param when declared", () => {
    const manifest = {
      auths: { primary: { delivery: { http: { in: "query", name: "access_token" } } } },
    };
    const { url, headers } = applyAuth("https://api/x", manifest, "tok", "primary");
    expect(url).toBe("https://api/x?access_token=tok");
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("checkAuthLiveness", () => {
  const okFetch = (status: number): typeof fetch =>
    (async () => new Response(null, { status })) as typeof fetch;
  // @appstrate/github is a seeded probe.
  const ghEntry = entry({
    packageId: "@appstrate/github",
    manifest: {
      auths: { primary: { delivery: { http: { name: "Authorization", prefix: "Bearer" } } } },
    },
  });

  afterEach(() => {
    delete process.env.CONFORMANCE_TOKENS;
    _resetCredsCache();
  });

  it("returns [] for an uncovered package (no probe)", async () => {
    const f = await checkAuthLiveness(entry({ packageId: "@appstrate/notion" }), {
      fetchImpl: okFetch(200),
    });
    expect(f).toEqual([]);
  });

  it("WARNs when a probe exists but no credential is configured", async () => {
    _resetCredsCache();
    const f = await checkAuthLiveness(ghEntry, { fetchImpl: okFetch(200) });
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
    expect(f[0]!.message).toContain("no credential");
  });

  it("INFO on expected status with a credential", async () => {
    process.env.CONFORMANCE_TOKENS = JSON.stringify({ "@appstrate/github": "tok" });
    _resetCredsCache();
    const f = await checkAuthLiveness(ghEntry, { fetchImpl: okFetch(200) });
    expect(f[0]!.severity).toBe("info");
  });

  it("FAILs on an unexpected status (token rejected)", async () => {
    process.env.CONFORMANCE_TOKENS = JSON.stringify({ "@appstrate/github": "bad" });
    _resetCredsCache();
    const f = await checkAuthLiveness(ghEntry, { fetchImpl: okFetch(401) });
    expect(f[0]!.severity).toBe("fail");
    expect(f[0]!.message).toContain("401");
  });

  it("WARNs on a network error", async () => {
    process.env.CONFORMANCE_TOKENS = JSON.stringify({ "@appstrate/github": "tok" });
    _resetCredsCache();
    const boom = (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;
    const f = await checkAuthLiveness(ghEntry, { fetchImpl: boom });
    expect(f[0]!.severity).toBe("warn");
  });
});

describe("listAllTools — pagination", () => {
  function fakeClient(pages: Array<{ tools: { name: string }[]; nextCursor?: string }>) {
    let call = 0;
    return {
      client: {
        listTools: async () => pages[call++ % pages.length],
      },
    } as unknown as AppstrateMcpClient;
  }

  it("concatenates across cursor pages", async () => {
    const client = fakeClient([
      { tools: [{ name: "a" }, { name: "b" }], nextCursor: "p2" },
      { tools: [{ name: "c" }] },
    ]);
    const tools = await listAllTools(client);
    expect(tools.map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("returns a single page when no cursor", async () => {
    const client = fakeClient([{ tools: [{ name: "only" }] }]);
    expect((await listAllTools(client)).map((t) => t.name)).toEqual(["only"]);
  });

  it("aborts a runaway cursor via maxPages", async () => {
    const client = fakeClient([{ tools: [{ name: "x" }], nextCursor: "loops-forever" }]);
    await expect(listAllTools(client, { maxPages: 3 })).rejects.toThrow(/exceeded 3 pages/);
  });
});

describe("snapshot", () => {
  it("slugifies a package id to a filesystem-safe name", () => {
    expect(snapshotSlug("@appstrate/notion-mcp")).toBe("_appstrate_notion-mcp");
  });

  it("writes the full tool surface sorted by name and reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conformance-snap-"));
    try {
      await writeSnapshot(dir, "@x/p", [
        { name: "b", description: "second", inputSchema: { type: "object" } },
        { name: "a", description: "first", inputSchema: { type: "number" } },
      ]);
      const back = await readSnapshot(dir, "@x/p");
      expect(back?.packageId).toBe("@x/p");
      expect(back?.tools.map((t) => t.name)).toEqual(["a", "b"]); // sorted
      expect(back?.tools[0]).toEqual({
        name: "a",
        description: "first",
        inputSchema: { type: "number" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("readSnapshot returns null when absent", async () => {
    expect(await readSnapshot(tmpdir(), "@x/does-not-exist-xyz")).toBeNull();
  });
});
