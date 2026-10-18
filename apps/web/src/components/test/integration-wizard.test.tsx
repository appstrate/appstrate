// SPDX-License-Identifier: Apache-2.0

/**
 * The guided addition from an MCP server URL: the creation hand-off offers it first for an
 * integration only, the review lists what this space already reaches at that address, and the
 * tools step shows every tool with the read-only ones pre-checked and the version it publishes.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { DiscoveryResult } from "../../lib/integration-wizard.ts";
import type { ServerSyncProposal } from "../../lib/integration-server-sync.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { CreationHandoffChoices } = await import("../creation-handoff-modal.tsx");
const { ReviewStep } = await import("../integration-wizard/review-step.tsx");
const { ToolsChoice } = await import("../integration-wizard/tools-step.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const settingsFr = (await import("../../locales/fr/settings.json")).default;
const agentsFr = (await import("../../locales/fr/agents.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const noop = () => {};

describe("the creation hand-off", () => {
  it("offers the MCP URL first for an integration, then the manual configuration", () => {
    const html = render(
      <CreationHandoffChoices
        resource="integration"
        onFromUrl={noop}
        onManual={noop}
        onChat={noop}
      />,
    );
    const url = html.indexOf(settingsFr["creation.fromUrl.title"]);
    const manual = html.indexOf(settingsFr["creation.manual.integrationTitle"]);
    expect(url).toBeGreaterThanOrEqual(0);
    expect(manual).toBeGreaterThan(url);
    expect(html).toContain(settingsFr["creation.manual.integrationDescription"]);
    expect(html).toContain(settingsFr["creation.chat.title"]);
  });

  it("keeps a skill's choices as they were", () => {
    const html = render(<CreationHandoffChoices resource="skill" onManual={noop} onChat={noop} />);
    expect(html).not.toContain(settingsFr["creation.fromUrl.title"]);
    expect(html).toContain(settingsFr["creation.manual.title"]);
  });
});

const discovery = {
  manifest: {
    display_name: "Acme",
    name: "@org/acme",
    source: {
      kind: "remote",
      remote: { url: "https://mcp.acme.test/mcp", transport: "streamable-http" },
    },
    auths: { oauth: { type: "oauth2", token_endpoint_auth_method: "none" } },
  },
  icon_source: null,
  provenance: { "/display_name": "detected", "/name": "guessed", "/auths/oauth": "detected" },
  warnings: [],
  existing: [{ integration_package_id: "@org/acme-old", display_name: "Acme (ancienne)" }],
} as unknown as DiscoveryResult;

describe("the review", () => {
  const review = () =>
    render(
      <ReviewStep
        result={discovery}
        edits={{ display_name: "Acme", name: "@org/acme" }}
        onEditsChange={noop}
        icon={undefined}
        onCreate={noop}
        creating={false}
        createError={null}
        onManual={noop}
      />,
    );

  it("lists the integration already at this address, with a link, and still offers to create", () => {
    const html = review();
    expect(html).toContain(agentsFr["integrationWizard.review.existing.title"]);
    expect(html).toContain('href="/integrations/@org/acme-old"');
    expect(html).toContain("Acme (ancienne)");
    expect(html).toContain(agentsFr["integrationWizard.review.create"]);
  });

  it("says how an account connects and what creating does, without the transport", () => {
    const html = review();
    expect(html).toContain(agentsFr["integrationWizard.review.auth.oauthAuto"]);
    expect(html).toContain(agentsFr["integrationWizard.review.effect"]);
    expect(html).toContain(agentsFr["integrationEditor.discover.detected"]);
    expect(html).toContain(agentsFr["integrationEditor.discover.guessed"]);
    expect(html).not.toContain("streamable-http");
  });

  it("creates without publishing, and says so", () => {
    const html = review();
    expect(html).toContain(">Créer</button>");
    expect(html).not.toContain("publier</button>");
    expect(agentsFr["integrationWizard.review.effect"]).toContain("Rien n’est publié");
  });

  it("stops marking a name or identifier the user changed as detected or suggested", () => {
    const html = render(
      <ReviewStep
        result={discovery}
        edits={{ display_name: "Mon Acme", name: "@org/mon-acme" }}
        onEditsChange={noop}
        icon={undefined}
        onCreate={noop}
        creating={false}
        createError={null}
        onManual={noop}
      />,
    );
    expect(html).not.toContain(agentsFr["integrationEditor.discover.guessed"]);
    // The auth line keeps its own badge.
    expect(html).toContain(agentsFr["integrationEditor.discover.detected"]);
  });
});

const catalog = {
  manifest: { default_tools: ["search"], tools_policy: { search: {}, delete_page: {} } },
  icon_source: null,
  instructions: "# Acme",
  tools: [
    { name: "search", title: "Rechercher", description: "Cherche des pages.", read_only: true },
    { name: "delete_page", read_only: false },
  ],
  warnings: [],
} as unknown as ServerSyncProposal;

describe("the tools step", () => {
  const choice = (
    selected: string[],
    over: { proposal?: ServerSyncProposal; otherDraftChanges?: boolean; pending?: boolean } = {},
  ) =>
    render(
      <ToolsChoice
        proposal={over.proposal ?? catalog}
        otherDraftChanges={over.otherDraftChanges ?? false}
        detailPath="/integrations/@org/acme"
        onRetry={noop}
        refetching={false}
        selected={new Set(selected)}
        onSelectedChange={noop}
        includeDocs
        onIncludeDocsChange={noop}
        version="1.1.0"
        onSubmit={noop}
        pending={over.pending ?? false}
        saveError={null}
        publishError={null}
      />,
    );
  /** Whether the tool's box renders checked (Radix draws it as a `button`). */
  const checked = (html: string, name: string) => {
    const tag = new RegExp(`<button[^>]*id="integration-wizard-tool-${name}"[^>]*>`).exec(html);
    return tag?.[0].includes('aria-checked="true"');
  };

  it("shows every tool, the read-only one badged and pre-checked", () => {
    const html = choice(["search"]);
    expect(html).toContain("Rechercher");
    expect(html).toContain("Cherche des pages.");
    expect(html).toContain("delete_page");
    expect(html.match(new RegExp(agentsFr["integrationWizard.tools.readOnly"], "g"))).toHaveLength(
      1,
    );
    expect(checked(html, "search")).toBe(true);
    expect(checked(html, "delete_page")).toBe(false);
  });

  it("counts the declared and selected tools and names the version it publishes", () => {
    const html = choice(["search"]);
    expect(html).toContain("2 outils déclarés.");
    expect(html).toContain("1 sélectionné par défaut pour les agents.");
    expect(html).toContain("Enregistrer et publier la version 1.1.0");
    expect(html).toContain(agentsFr["integrationWizard.tools.docs"]);
  });

  it("warns that the draft's other unpublished changes ship with the tools", () => {
    expect(choice(["search"])).not.toContain("integration-wizard-draft-changes");
    const html = choice(["search"], { otherDraftChanges: true });
    expect(html).toContain("integration-wizard-draft-changes");
    expect(html).toContain('href="/integrations/@org/acme"');
    expect(html).toContain("Enregistrer et publier la version 1.1.0");
  });

  it("freezes the whole selection, the select-all and select-none buttons included, while saving", () => {
    const button = (html: string, label: string) =>
      new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? "";
    for (const key of ["integrationWizard.tools.selectAll", "integrationWizard.tools.selectNone"]) {
      const label = agentsFr[key as keyof typeof agentsFr];
      expect(button(choice(["search"]), label)).not.toContain(" disabled=");
      expect(button(choice(["search"], { pending: true }), label)).toContain(" disabled=");
    }
  });

  it("offers no publish when the server lists no tool", () => {
    const empty = { ...catalog, tools: [], instructions: null } as ServerSyncProposal;
    const html = choice([], { proposal: empty });
    expect(html).toContain(agentsFr["integrationWizard.tools.none"]);
    expect(html).toContain(agentsFr["integrationWizard.tools.retry"]);
    expect(html).toContain('href="/integrations/@org/acme"');
    expect(html).not.toContain("integration-wizard-publish");
  });
});
