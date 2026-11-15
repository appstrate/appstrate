// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { PackageOverview } from "../package-detail/package-overview";
import { Markdown } from "../markdown-impl";
import agentsFr from "../../locales/fr/agents.json";
import i18n, { i18nReady } from "../../i18n";

await i18nReady;
await i18n.changeLanguage("fr");
const noop = () => {};
function render(props: Partial<ComponentProps<typeof PackageOverview>> = {}) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PackageOverview
        type="skill"
        content="Vérifiez les pièces sources."
        manifest={{ description: "Méthode de rapprochement", version: "1.4.0", license: "MIT" }}
        historical={false}
        agentCount={2}
        onOpenFiles={noop}
        onOpenUsage={noop}
        {...props}
      />
    </I18nextProvider>,
  );
}

describe("package overview", () => {
  it("shows what the package does here, not what the catalogue sheet says it is", () => {
    const html = render();
    expect(html).toContain("Vérifiez les pièces sources.");
    expect(html).toContain("2");
    expect(html).not.toContain("Méthode de rapprochement");
    expect(html).not.toContain("1.4.0");
    expect(html).not.toContain("MIT");
  });
  it("provides a useful MCP summary without inventing a tool count", () => {
    const html = render({ type: "mcp-server", content: null });
    expect(html).toContain("Le manifeste ne fournit pas de catalogue");
    expect(html).not.toContain("Lire les instructions complètes");
    expect(html).toContain("Parcourir les fichiers");
  });
  it("previews the instructions, not the frontmatter that names the skill", () => {
    const html = render({
      content:
        "---\nname: rapprochement\ndescription: Rapproche les pièces.\n---\n\nVérifiez les pièces sources.",
    });
    expect(html).toContain("Vérifiez les pièces sources.");
    expect(html).not.toContain("name: rapprochement");
    expect(html).not.toContain("<h2>");
  });
  it("does not offer an empty usage link", () => {
    expect(render({ agentCount: 0 })).not.toContain("Voir les agents utilisateurs");
  });
  it("identifies live usage even when inspecting an archived version", () => {
    expect(render({ historical: true })).toContain("toutes versions confondues");
  });
  it("renders author-controlled previews without links, images or raw HTML", () => {
    const html = renderToStaticMarkup(
      <Markdown inert>
        {
          '# Instructions\n\n**Verify** [the source](https://source.invalid)\n\n![pixel](https://tracking.invalid/pixel)\n\n<img src="https://tracking.invalid/raw"><script>boom()</script>'
        }
      </Markdown>,
    );
    expect(html).toContain("<h1>Instructions</h1>");
    expect(html).toContain("<strong>Verify</strong>");
    expect(html).toContain("the source");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("https://");
  });
});

describe("mcp-server overview", () => {
  function mcpServer(manifest: Record<string, unknown>) {
    return render({
      type: "mcp-server",
      content: null,
      manifest: { name: "@acme/gh-mcp", version: "1.0.0", type: "mcp-server", ...manifest },
    });
  }

  it("renders the launch line as the one command the runner executes", () => {
    const html = mcpServer({
      server: {
        type: "node",
        entry_point: "dist/index.js",
        mcp_config: { command: "node", args: ["dist/index.js"] },
      },
    });
    expect(html).toContain(agentsFr["manifest.server"]);
    expect(html).toContain("node dist/index.js");
  });

  it("flags the user config the installer has to supply", () => {
    const html = mcpServer({
      user_config: { token: { type: "string", required: true, sensitive: true } },
    });
    expect(html).toContain("token");
    expect(html).toContain(agentsFr["manifest.required"]);
    expect(html).toContain(agentsFr["manifest.sensitive"]);
  });

  it("reproduces a repeated flag instead of collapsing it", () => {
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
    // Appstrate override the runner reads.
    const html = mcpServer({
      _meta: { "dev.appstrate/mcp-server": { runtime: "bun" } },
      server: { type: "node", mcp_config: { command: "bun", args: ["src/index.ts"] } },
    });
    expect(html).toContain(agentsFr["manifest.serverRuntime"]);
    expect(html).toContain(">bun<");
    expect(html).not.toContain(">node<");
  });
});
