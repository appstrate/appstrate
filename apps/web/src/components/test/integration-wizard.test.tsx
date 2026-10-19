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

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});

const { CreationHandoffChoices } = await import("../creation-handoff-modal.tsx");
const { ReviewStep } = await import("../integration-wizard/review-step.tsx");
const { ToolsChoice, ToolsStep } = await import("../integration-wizard/tools-step.tsx");
const { catalogConnectionsKey, catalogSourceKey } = await import("../../lib/integration-wizard.ts");
const { QueryClient } = await import("@tanstack/react-query");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const settingsFr = (await import("../../locales/fr/settings.json")).default;
const agentsFr = (await import("../../locales/fr/agents.json")).default;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const noop = () => {};

describe("the creation hand-off", () => {
  it("offers the MCP URL first for an integration, then the same manual way as every type", () => {
    const html = render(
      <CreationHandoffChoices
        resource="integration"
        onFromUrl={noop}
        onManual={noop}
        onChat={noop}
        onImport={noop}
      />,
    );
    const url = html.indexOf(settingsFr["creation.fromUrl.title"]);
    const manual = html.indexOf(settingsFr["creation.manual.title"]);
    expect(url).toBeGreaterThanOrEqual(0);
    expect(manual).toBeGreaterThan(url);
    expect(html).toContain(settingsFr["creation.manual.description"]);
    expect(html).toContain(settingsFr["creation.chat.title"]);
    expect(html).toContain(settingsFr["creation.import.title"]);
  });

  it("keeps a skill's choices as they were", () => {
    const html = render(
      <CreationHandoffChoices resource="skill" onManual={noop} onChat={noop} onImport={noop} />,
    );
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
        creating={null}
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
    expect(html).toContain(agentsFr["integrationWizard.review.detected"]);
    expect(html).toContain(agentsFr["integrationWizard.review.guessed"]);
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
        creating={null}
        createError={null}
        onManual={noop}
      />,
    );
    expect(html).not.toContain(agentsFr["integrationWizard.review.guessed"]);
    // The auth line keeps its own badge.
    expect(html).toContain(agentsFr["integrationWizard.review.detected"]);
  });

  it("says a server answering without authentication needs no connection, and how its address is kept", () => {
    const { auths: _auths, ...manifest } = discovery.manifest;
    const html = render(
      <ReviewStep
        result={{ ...discovery, manifest }}
        edits={{ display_name: "Acme", name: "@org/acme" }}
        onEditsChange={noop}
        icon={undefined}
        onCreate={noop}
        creating={null}
        createError={null}
        onManual={noop}
      />,
    );
    expect(html).toContain(agentsFr["integrationWizard.review.auth.none"]);
    expect(html).toContain('data-testid="integration-wizard-url-shared"');
    expect(html).toContain("https://mcp.acme.test/mcp");
  });

  it("shows no address notice for a server asking for authentication", () => {
    expect(review()).not.toContain('data-testid="integration-wizard-url-shared"');
  });
});

const catalog = {
  manifest: { default_tools: ["search"], tools_policy: { search: {}, delete_page: {} } },
  icon_source: null,
  instructions: "# Acme",
  tools: [
    {
      name: "search",
      title: "Rechercher",
      description: "Cherche des pages.",
      read_only: true,
      destructive: false,
    },
    { name: "delete_page", read_only: false, destructive: true },
    { name: "purge", read_only: true, destructive: true },
  ],
  warnings: [],
} as unknown as ServerSyncProposal;

describe("the tools step", () => {
  const choice = (
    selected: string[],
    over: {
      proposal?: ServerSyncProposal;
      otherDraftChanges?: boolean;
      pending?: boolean;
      draftMoved?: boolean;
    } = {},
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
        draftMoved={over.draftMoved ?? false}
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
      2,
    );
    expect(checked(html, "search")).toBe(true);
    expect(checked(html, "delete_page")).toBe(false);
  });

  it("badges a destructive tool, a tool marked both read-only and destructive as read-only", () => {
    const html = choice(["search"]);
    const label = agentsFr["integrationWizard.tools.destructive"];
    // `delete_page` alone: `purge` says both, and read-only wins the badge.
    expect(html.match(new RegExp(`>${label}<`, "g"))).toHaveLength(1);
    const at = (name: string) => html.indexOf(`id="integration-wizard-tool-${name}"`);
    expect(html.slice(at("delete_page"), at("purge"))).toContain(`>${label}<`);
    expect(html.slice(at("purge"))).not.toContain(`>${label}<`);
  });

  it("counts the declared and selected tools and names the version it publishes", () => {
    const html = choice(["search"]);
    // Nothing is declared before the save: the server offers.
    expect(html).toContain("3 outils proposés par le serveur.");
    expect(html).not.toContain("déclaré");
    expect(html).toContain("1 sera sélectionné par défaut pour les agents.");
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

  it("says the draft moved after a publish refused with 412, and offers the full submit again", () => {
    expect(choice(["search"])).not.toContain("integration-wizard-draft-moved");
    const html = choice(["search"], { draftMoved: true });
    expect(html).toContain("integration-wizard-draft-moved");
    expect(html).toContain("Enregistrer et publier la version 1.1.0");
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

describe("the tools step, resumed", () => {
  // An open server (AFPS §7.2): the step reads it without the proxy permission.
  const source = {
    kind: "remote",
    remote: { url: "https://mcp.acme.test/mcp", transport: "streamable-http" },
  };
  const published = { name: "@org/acme", version: "1.0.0", display_name: "Acme", source };
  const detail = { manifest: published, auths: [] } as unknown as Parameters<
    typeof ToolsStep
  >[0]["detail"];
  const step = (draft: Record<string, unknown>, hasUnarchivedChanges: boolean) => {
    const qc = new QueryClient();
    // The server read, as the step keys it (no org or space selected in this harness).
    qc.setQueryData(
      [
        "integration-server-catalog",
        null,
        null,
        "@org/acme",
        catalogSourceKey(draft),
        catalogConnectionsKey(detail),
        null,
      ],
      catalog,
    );
    return render(
      <ToolsStep
        packageId="@org/acme"
        draft={
          {
            id: "@org/acme",
            manifest: draft,
            home_writable: true,
            has_unarchived_changes: hasUnarchivedChanges,
            etag: '"3"',
          } as unknown as Parameters<typeof ToolsStep>[0]["draft"]
        }
        detail={detail}
        version="1.1.0"
        published
      />,
      { queryClient: qc },
    );
  };

  it("follows the server flag has_unarchived_changes: the publication ships the whole draft", () => {
    // The warning follows the server flag read at mount and states that the publication ships the
    // whole draft; it also shows after a wizard save whose publish failed.
    const savedByWizard = {
      ...published,
      version: "1.1.0",
      tools_policy: { search: {}, delete_page: {} },
      default_tools: ["search"],
    };
    expect(step(savedByWizard, true)).toContain("integration-wizard-draft-changes");
    const clean = step(savedByWizard, false);
    // The catalogue rendered: the absence below is the step's verdict, not a loading state.
    expect(clean).toContain("integration-wizard-publish");
    expect(clean).not.toContain("integration-wizard-draft-changes");
  });
});
