// SPDX-License-Identifier: Apache-2.0

/**
 * Readers behind the manifest overview.
 *
 * These are the rules the rendered view cannot restate: a manifest is
 * author-controlled jsonb, so "which fields are present", "which strings may
 * become an href" and "which repeated entries collapse" are decided here,
 * once, rather than in each JSX branch.
 */

import { describe, it, expect } from "bun:test";
import {
  readIntegrationDetails,
  readIntegrationSource,
  readManifestOverview,
  readMcpServerDetails,
} from "../package-manifest.ts";

/** The narrowest manifest the AFPS skill schema accepts. */
const MINIMAL = { name: "@acme/tidy", version: "1.0.0", type: "skill" };

describe("readManifestOverview", () => {
  it("emits nothing for a manifest carrying only its required fields", () => {
    const overview = readManifestOverview(MINIMAL);

    // `name` / `version` / `type` are the page header's job — repeating them
    // here would be the same fact twice on one screen.
    expect(overview.facts).toEqual([]);
    expect(overview.links).toEqual([]);
    expect(overview.keywords).toEqual([]);
    expect(overview.dependencies).toEqual([]);
    expect(overview.longDescription).toBeUndefined();
    expect(overview.isEmpty).toBe(true);
  });

  it("treats a blank string as an absent field", () => {
    // An empty `license` would otherwise render a labelled row with no value —
    // exactly the empty row the view must never emit.
    const overview = readManifestOverview({ ...MINIMAL, license: "   ", homepage: "" });

    expect(overview.facts).toEqual([]);
    expect(overview.links).toEqual([]);
    expect(overview.isEmpty).toBe(true);
  });

  it("keeps the declared metadata in a fixed order", () => {
    const overview = readManifestOverview({
      ...MINIMAL,
      schema_version: "0.2",
      license: "Apache-2.0",
      compatibility: { platforms: ["darwin", "linux"], runtimes: { node: ">=20" } },
      author: { name: "Ada", email: "ada@example.com" },
    });

    expect(overview.facts).toEqual([
      { labelKey: "manifest.license", value: "Apache-2.0" },
      { labelKey: "manifest.author", value: "Ada <ada@example.com>" },
      { labelKey: "manifest.schemaVersion", value: "0.2" },
      { labelKey: "manifest.platforms", value: "darwin, linux" },
      { labelKey: "manifest.runtimes", value: "node >=20" },
    ]);
    expect(overview.isEmpty).toBe(false);
  });

  it("accepts author and repository in either of their two schema shapes", () => {
    const asStrings = readManifestOverview({
      ...MINIMAL,
      author: "Ada",
      repository: "https://github.com/acme/tidy",
    });
    const asObjects = readManifestOverview({
      ...MINIMAL,
      author: { name: "Ada" },
      repository: { type: "git", url: "https://github.com/acme/tidy" },
    });

    expect(asStrings.facts).toEqual([{ labelKey: "manifest.author", value: "Ada" }]);
    expect(asStrings.links).toEqual(asObjects.links);
    expect(asStrings.facts).toEqual(asObjects.facts);
  });

  it("links an http(s) URL and leaves every other value as text", () => {
    const overview = readManifestOverview({
      ...MINIMAL,
      homepage: "https://acme.test/tidy",
      // The whole reason this reader exists: `new URL()` accepts this happily.
      documentation: "javascript:alert(document.cookie)",
      support: "support@acme.test",
      privacy_policies: ["https://acme.test/privacy", "//evil.test/privacy"],
    });

    expect(overview.links).toEqual([
      {
        labelKey: "manifest.homepage",
        value: "https://acme.test/tidy",
        href: "https://acme.test/tidy",
      },
      { labelKey: "manifest.documentation", value: "javascript:alert(document.cookie)" },
      { labelKey: "manifest.support", value: "support@acme.test" },
      {
        labelKey: "manifest.privacyPolicy",
        value: "https://acme.test/privacy",
        href: "https://acme.test/privacy",
      },
      // Scheme-relative: the one a `startsWith("http")` check would let past,
      // and an off-origin navigation dressed up as a relative path.
      { labelKey: "manifest.privacyPolicy", value: "//evil.test/privacy" },
    ]);
  });

  it("emits no href for a repository that is a javascript: URL", () => {
    // The hole this reader closes: `integration-detail.tsx` used to render
    // `<a href={manifest.repository}>` unchecked, and an integration is
    // importable from a ZIP or a GitHub URL, so the value is attacker-reachable.
    // Both schema shapes go through the same check.
    for (const repository of ["javascript:alert(1)", { type: "git", url: "javascript:alert(1)" }]) {
      const [repo] = readManifestOverview({ ...MINIMAL, repository }).links;

      expect(repo).toEqual({ labelKey: "manifest.repository", value: "javascript:alert(1)" });
      expect(repo).not.toHaveProperty("href");
    }
  });

  it("groups dependencies by kind and drops the empty groups", () => {
    const overview = readManifestOverview({
      ...MINIMAL,
      dependencies: {
        skills: { "@acme/lint": "^1.0.0" },
        mcp_servers: {},
        integrations: { "@acme/github": "~2.1.0" },
      },
    });

    expect(overview.dependencies).toEqual([
      { labelKey: "manifest.depSkills", entries: [{ id: "@acme/lint", range: "^1.0.0" }] },
      {
        labelKey: "manifest.depIntegrations",
        entries: [{ id: "@acme/github", range: "~2.1.0" }],
      },
    ]);
  });

  it("survives a manifest that is not an object at all", () => {
    // jsonb: nothing guarantees the column holds what the schema describes.
    for (const value of [undefined, null, "manifest", 42, ["a"]]) {
      expect(readManifestOverview(value).isEmpty).toBe(true);
    }
  });
});

describe("readIntegrationSource", () => {
  it("reads the local branch", () => {
    expect(
      readIntegrationSource({
        kind: "local",
        server: { name: "@acme/gh-mcp", version: "1.2.3", vendored: true },
      }),
    ).toEqual({
      kind: "local",
      serverName: "@acme/gh-mcp",
      serverVersion: "1.2.3",
      vendored: true,
    });
  });

  it("reads the remote branch", () => {
    expect(
      readIntegrationSource({
        kind: "remote",
        remote: { url: "https://mcp.acme.test/v1", transport: "streamable-http" },
      }),
    ).toEqual({ kind: "remote", url: "https://mcp.acme.test/v1", transport: "streamable-http" });
  });

  it("reads the none branch, which carries nothing else", () => {
    expect(readIntegrationSource({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("drops a branch whose payload does not match its kind", () => {
    // Half a source renders as half a card: "Serveur MCP embarqué" over a
    // blank package name. Better to render no source section at all.
    expect(
      readIntegrationSource({ kind: "local", remote: { url: "https://x.test" } }),
    ).toBeUndefined();
    expect(
      readIntegrationSource({ kind: "remote", remote: { url: "https://x.test" } }),
    ).toBeUndefined();
    expect(readIntegrationSource({ kind: "local", server: { name: "@a/b" } })).toBeUndefined();
    expect(readIntegrationSource({ kind: "smtp" })).toBeUndefined();
    expect(readIntegrationSource(undefined)).toBeUndefined();
  });
});

describe("readIntegrationDetails", () => {
  it("reads the auths with their default scopes", () => {
    const details = readIntegrationDetails({
      ...MINIMAL,
      type: "integration",
      source: { kind: "none" },
      auths: {
        oauth: { type: "oauth2", default_scopes: ["repo"], issuer: "https://acme.test" },
        pat: { type: "api_key" },
      },
    });

    expect(details.auths).toEqual([
      { id: "oauth", type: "oauth2", defaultScopes: ["repo"] },
      { id: "pat", type: "api_key", defaultScopes: [] },
    ]);
    expect(details.isEmpty).toBe(false);
  });

  it("is empty for a manifest that declares no integration tail", () => {
    const details = readIntegrationDetails(MINIMAL);

    expect(details).toEqual({ auths: [], allowUndeclaredTools: false, isEmpty: true });
  });

  it("reports the wildcard opt-in only when it is literally true", () => {
    expect(readIntegrationDetails({ allow_undeclared_tools: true }).allowUndeclaredTools).toBe(
      true,
    );
    expect(readIntegrationDetails({ allow_undeclared_tools: "true" }).allowUndeclaredTools).toBe(
      false,
    );
  });
});

describe("readMcpServerDetails", () => {
  it("reads the launch facts and the declared surface", () => {
    const details = readMcpServerDetails({
      name: "@acme/gh-mcp",
      version: "1.0.0",
      type: "mcp-server",
      manifest_version: "0.4",
      server: {
        type: "node",
        entry_point: "dist/index.js",
        mcp_config: { command: "node", args: ["dist/index.js", "--stdio"] },
      },
      tools: [{ name: "list_repos", description: "List repositories" }, { name: "whoami" }, {}],
      user_config: { token: { type: "string", title: "Token", required: true, sensitive: true } },
    });

    expect(details.manifestVersion).toBe("0.4");
    expect(details.server).toEqual({
      runtime: "node",
      entryPoint: "dist/index.js",
      command: "node",
      args: ["dist/index.js", "--stdio"],
    });
    // The nameless third entry is dropped rather than rendered as a blank row.
    expect(details.tools).toEqual([
      { name: "list_repos", description: "List repositories" },
      { name: "whoami" },
    ]);
    expect(details.userConfig).toEqual([
      { key: "token", title: "Token", type: "string", required: true, sensitive: true },
    ]);
    expect(details.isEmpty).toBe(false);
  });

  it("is empty for a manifest that declares no server tail", () => {
    expect(readMcpServerDetails(MINIMAL).isEmpty).toBe(true);
    expect(readMcpServerDetails({ server: {} }).server).toBeUndefined();
  });

  it("reports the runtime the platform would resolve, not the MCPB vocabulary", () => {
    // The case core's own docstring records: MCPB's `server.type` enum has no
    // `bun`, so a bun-native server keeps `server.type: "node"` and declares
    // `bun` under `_meta`. The runner reads `_meta` first
    // (`getMcpServerRuntime(manifest) ?? run.type`); reading `server.type` here
    // labelled this server "node", which is not how it runs.
    const details = readMcpServerDetails({
      ...MINIMAL,
      type: "mcp-server",
      _meta: { "dev.appstrate/mcp-server": { runtime: "bun" } },
      server: { type: "node", mcp_config: { command: "bun", args: ["src/index.ts"] } },
    });

    expect(details.server?.runtime).toBe("bun");
  });

  it("falls back to server.type when _meta declares nothing usable", () => {
    // Same order the resolver uses, including its narrowing: `_meta` is
    // author-controlled jsonb, so an unrecognised runtime is not a runtime.
    for (const meta of [
      undefined,
      {},
      { "dev.appstrate/mcp-server": {} },
      { "dev.appstrate/mcp-server": { runtime: "deno" } },
      { "dev.appstrate/mcp-server": "bun" },
    ]) {
      const details = readMcpServerDetails({
        ...MINIMAL,
        type: "mcp-server",
        ...(meta ? { _meta: meta } : {}),
        server: { type: "python", entry_point: "main.py" },
      });

      expect(details.server?.runtime).toBe("python");
    }
  });
});

describe("author-controlled arrays are reproduced verbatim", () => {
  it("keeps repeated keywords, platforms and privacy policies", () => {
    // These used to be deduped through a `Set` so the keyed lists that render
    // them could not emit duplicate React keys. That is the renderer's problem
    // (every keyed site now includes the index) — editing the author's array on
    // the way to the screen is not a rendering concern, and the same helper
    // reads `mcp_config.args`, where dropping a repeat changes a command line.
    const overview = readManifestOverview({
      ...MINIMAL,
      keywords: ["tidy", "tidy", " ", "cli"],
      privacy_policies: ["https://acme.test/privacy", "https://acme.test/privacy"],
      compatibility: { platforms: ["linux", "linux", "darwin"] },
    });

    // The blank is still dropped — that rule is about a row with no value.
    expect(overview.keywords).toEqual(["tidy", "tidy", "cli"]);
    expect(overview.links.filter((l) => l.labelKey === "manifest.privacyPolicy")).toHaveLength(2);
    expect(overview.facts.find((f) => f.labelKey === "manifest.platforms")?.value).toBe(
      "linux, linux, darwin",
    );
  });

  it("round-trips a repeated launch flag in mcp_config.args", () => {
    // The defect the `Set` caused, on the one call site where the array is an
    // ORDERED MULTISET: `uv run --with pkgA --with pkgB server.py` is how the
    // runner starts this server, and `McpServerDetails` renders
    // `[command, ...args].join(" ")` as exactly that line. Deduping produced
    // `uv run --with pkgA pkgB server.py` — a command the author never wrote,
    // and one that installs a single package instead of two.
    const args = ["run", "--with", "pkgA", "--with", "pkgB", "server.py"];
    const details = readMcpServerDetails({
      ...MINIMAL,
      type: "mcp-server",
      server: { type: "uv", mcp_config: { command: "uv", args } },
    });

    expect(details.server?.args).toEqual(args);
    expect([details.server!.command, ...details.server!.args].join(" ")).toBe(
      "uv run --with pkgA --with pkgB server.py",
    );
  });

  it("dedupes an mcp-server's tools by name, keeping the first declaration", () => {
    const details = readMcpServerDetails({
      ...MINIMAL,
      type: "mcp-server",
      tools: [
        { name: "list_repos", description: "first" },
        { name: "list_repos", description: "second" },
        { name: "whoami" },
      ],
    });

    expect(details.tools).toEqual([
      { name: "list_repos", description: "first" },
      { name: "whoami" },
    ]);
  });

  it("keeps a repeated default scope", () => {
    const details = readIntegrationDetails({
      ...MINIMAL,
      type: "integration",
      auths: { google: { type: "oauth2", default_scopes: ["drive.readonly", "drive.readonly"] } },
    });

    expect(details.auths[0]!.defaultScopes).toEqual(["drive.readonly", "drive.readonly"]);
  });
});
