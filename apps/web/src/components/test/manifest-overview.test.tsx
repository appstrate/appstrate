// SPDX-License-Identifier: Apache-2.0

/**
 * `ManifestOverview` render tests.
 *
 * The web test runner has no DOM, so the component is rendered with
 * `renderToStaticMarkup` and asserted on its HTML — enough for what is under
 * test here: which blocks a manifest produces, and what a manifest string is
 * allowed to become. The reader rules themselves are covered in
 * `lib/test/package-manifest.test.ts`; this file proves the component actually
 * routes through them.
 */

import type { ReactElement } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import agentsFr from "../../locales/fr/agents.json";
import i18n, { i18nReady } from "../../i18n.ts";
import { ManifestOverview } from "../package-manifest/manifest-overview.tsx";

// The SPA's own i18n singleton, with the language pinned rather than left to
// whatever the runner defaults to — the assertions read French labels.
await i18nReady;
await i18n.changeLanguage("fr");

function render(node: ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

describe("ManifestOverview with a required-fields-only manifest", () => {
  const html = render(
    <ManifestOverview
      manifest={{ name: "@acme/tidy", version: "1.0.0", type: "skill" }}
      type="skill"
    />,
  );

  it("renders an empty state instead of labelled blanks", () => {
    expect(html).toContain(agentsFr["manifest.empty"]);
  });

  it("emits no section at all — not one with an em dash in it", () => {
    for (const label of ["manifest.metadata", "manifest.links", "manifest.dependencies"] as const) {
      expect(html).not.toContain(agentsFr[label]);
    }
    expect(html).not.toContain("—");
  });
});

describe("ManifestOverview links", () => {
  const html = render(
    <ManifestOverview
      manifest={{
        name: "@acme/tidy",
        version: "1.0.0",
        type: "skill",
        homepage: "javascript:alert(document.cookie)",
        repository: { type: "git", url: "https://github.com/acme/tidy" },
      }}
      type="skill"
    />,
  );

  it("never turns a non-http(s) manifest string into an href", () => {
    // A manifest is author-controlled: publishing one with this homepage would
    // otherwise hand every viewer's session to its author.
    expect(html).toContain("javascript:alert(document.cookie)");
    expect(html).not.toContain('href="javascript:');
  });

  it("links the URLs that are safe, and opts the tab out of window.opener", () => {
    expect(html).toContain('href="https://github.com/acme/tidy"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("ManifestOverview shared metadata", () => {
  const html = render(
    <ManifestOverview
      manifest={{
        name: "@acme/tidy",
        version: "2.0.0",
        type: "skill",
        display_name: "Tidy",
        description: "Range vos dépôts",
        long_description: "Un texte plus long.",
        keywords: ["git", "cleanup"],
        license: "Apache-2.0",
        dependencies: { skills: { "@acme/lint": "^1.0.0" } },
      }}
      type="skill"
    />,
  );

  it("renders the fields nothing else on the page shows", () => {
    expect(html).toContain("Un texte plus long.");
    expect(html).toContain("git");
    expect(html).toContain("Apache-2.0");
    expect(html).toContain("@acme/lint");
    expect(html).toContain(agentsFr["manifest.depSkills"]);
  });

  it("leaves the fields the page header already carries to the header", () => {
    expect(html).not.toContain("Tidy");
    expect(html).not.toContain("Range vos dépôts");
    expect(html).not.toContain("2.0.0");
  });

  it("gives a skill no type-specific tail — its schema has none", () => {
    expect(html).not.toContain(agentsFr["manifest.source"]);
    expect(html).not.toContain(agentsFr["manifest.auths"]);
    expect(html).not.toContain(agentsFr["manifest.server"]);
  });
});

describe("ManifestOverview integration tail", () => {
  function integration(manifest: Record<string, unknown>): string {
    return render(
      <ManifestOverview
        manifest={{ name: "@acme/gh", version: "1.0.0", type: "integration", ...manifest }}
        type="integration"
      />,
    );
  }

  it("names the local source with the mcp-server package it points at", () => {
    const html = integration({
      source: { kind: "local", server: { name: "@acme/gh-mcp", version: "1.2.3" } },
    });

    expect(html).toContain(agentsFr["manifest.sourceLocal"]);
    expect(html).toContain("@acme/gh-mcp");
    expect(html).toContain("1.2.3");
    expect(html).not.toContain(agentsFr["manifest.sourceRemote"]);
  });

  it("shows a remote source as its URL and transport, and never as a link", () => {
    const html = integration({
      source: { kind: "remote", remote: { url: "https://mcp.acme.test", transport: "sse" } },
    });

    expect(html).toContain(agentsFr["manifest.sourceRemote"]);
    expect(html).toContain("https://mcp.acme.test");
    expect(html).toContain("sse");
    // The URL addresses an MCP endpoint the platform calls server-side.
    expect(html).not.toContain('href="https://mcp.acme.test"');
  });

  it("names each auth with the scopes it requests by default", () => {
    // The gap this fills: the page's Configuration tab, which owns auths, is
    // admin-gated — a member had no way to see what the integration asks for.
    const html = integration({
      auths: {
        oauth: { type: "oauth2", default_scopes: ["repo", "read:user"] },
        pat: { type: "api_key" },
      },
    });

    expect(html).toContain("oauth");
    expect(html).toContain("oauth2");
    expect(html).toContain("repo");
    expect(html).toContain("read:user");
    expect(html).toContain("pat");
    expect(html).toContain("api_key");
  });

  it("leaves the tool map to the Tools tab, which resolves it better", () => {
    // `tools_policy` is deliberately unread: the integration page's Tools tab
    // renders the server-resolved catalog, descriptions included.
    const html = integration({
      tools_policy: { create_issue: { required_scopes: { oauth: ["write:issues"] } } },
    });

    expect(html).not.toContain("create_issue");
    expect(html).not.toContain("write:issues");
  });

  it("keeps the wildcard opt-in, which no other surface states", () => {
    const html = integration({ allow_undeclared_tools: true });

    expect(html).toContain(agentsFr["manifest.toolsPolicy"]);
    expect(html).toContain(agentsFr["manifest.allowUndeclaredTools"]);
  });

  it("emits no href for an integration whose repository is a javascript: URL", () => {
    // End-to-end through the component this time, on the exact type and mount
    // point where the unchecked `<a href={repo}>` used to live.
    const html = integration({ repository: { type: "git", url: "javascript:alert(1)" } });

    expect(html).toContain("javascript:alert(1)");
    expect(html).not.toContain("href=");
  });
});

describe("ManifestOverview mcp-server tail", () => {
  const html = render(
    <ManifestOverview
      manifest={{
        name: "@acme/gh-mcp",
        version: "1.0.0",
        type: "mcp-server",
        manifest_version: "0.4",
        server: {
          type: "node",
          entry_point: "dist/index.js",
          mcp_config: { command: "node", args: ["dist/index.js"] },
        },
        user_config: { token: { type: "string", required: true, sensitive: true } },
      }}
      type="mcp-server"
    />,
  );

  it("renders the launch line as the one command the runner executes", () => {
    expect(html).toContain(agentsFr["manifest.server"]);
    expect(html).toContain("node dist/index.js");
  });

  it("flags the user config the installer has to supply", () => {
    expect(html).toContain("token");
    expect(html).toContain(agentsFr["manifest.required"]);
    expect(html).toContain(agentsFr["manifest.sensitive"]);
  });
});

describe("ManifestOverview mcp-server launch line", () => {
  function mcpServer(manifest: Record<string, unknown>): string {
    return render(
      <ManifestOverview
        manifest={{ name: "@acme/gh-mcp", version: "1.0.0", type: "mcp-server", ...manifest }}
        type="mcp-server"
      />,
    );
  }

  it("reproduces a repeated flag instead of collapsing it", () => {
    // The reader used to push every string array through a `Set`, which is
    // right for `keywords` and wrong for an argv: this rendered
    // `uv run --with pkgA pkgB server.py`, silently deleting the second
    // `--with` and turning a two-package launch into a one-package one. The
    // existing case above only carries a single arg, which is why it shipped.
    const html = mcpServer({
      server: {
        type: "uv",
        mcp_config: {
          command: "uv",
          args: ["run", "--with", "pkgA", "--with", "pkgB", "server.py"],
        },
      },
    });

    expect(html).toContain("uv run --with pkgA --with pkgB server.py");
  });

  it("names the runtime the platform would actually start", () => {
    // `server.type` is MCPB vocabulary and has no `bun`; `_meta` carries the
    // Appstrate override the runner reads. The row must state the second.
    const html = mcpServer({
      _meta: { "dev.appstrate/mcp-server": { runtime: "bun" } },
      server: { type: "node", mcp_config: { command: "bun", args: ["src/index.ts"] } },
    });

    expect(html).toContain(agentsFr["manifest.serverRuntime"]);
    expect(html).toContain(">bun<");
    expect(html).not.toContain(">node<");
  });
});
