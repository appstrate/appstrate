// SPDX-License-Identifier: Apache-2.0

/**
 * The guided addition from an MCP server URL: the creation hand-off offers it first for an
 * integration only, the review lists what this space already reaches at that address, and the
 * tools step is one choice (review each tool, or trust the server) and the version it publishes.
 */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import type { DiscoveryResult } from "../../lib/integration-wizard.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});

const { CreationHandoffChoices } = await import("../creation-handoff-modal.tsx");
const { ReviewStep } = await import("../integration-wizard/review-step.tsx");
const { ToolsChoice, ToolsStep } = await import("../integration-wizard/tools-step.tsx");
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

/** The choice's radio, which Radix draws as a `button`. */
const radio = (html: string, mode: "review" | "trust") =>
  new RegExp(`<button[^>]*id="integration-wizard-mode-${mode}"[^>]*>`).exec(html)?.[0] ?? "";
const checked = (html: string, mode: "review" | "trust") =>
  radio(html, mode).includes('aria-checked="true"');

describe("the tools step", () => {
  const choice = (
    trustAll: boolean,
    over: { otherDraftChanges?: boolean; pending?: boolean; draftMoved?: boolean } = {},
  ) =>
    render(
      <ToolsChoice
        trustAll={trustAll}
        onTrustAllChange={noop}
        otherDraftChanges={over.otherDraftChanges ?? false}
        detailPath="/integrations/@org/acme"
        version="1.1.0"
        onSubmit={noop}
        pending={over.pending ?? false}
        saveError={null}
        publishError={null}
        draftMoved={over.draftMoved ?? false}
      />,
    );
  it("offers the review in each space, by default, and trusting the whole server", () => {
    const html = choice(false);
    expect(html).toContain(agentsFr["integrationWizard.tools.mode.review.label"]);
    expect(html).toContain(agentsFr["integrationWizard.tools.mode.trust.label"]);
    expect(checked(html, "review")).toBe(true);
    expect(checked(html, "trust")).toBe(false);
    expect(checked(choice(true), "trust")).toBe(true);
  });

  it("declares no tool to pick and names the version it publishes", () => {
    const html = choice(false);
    expect(html).not.toContain("integration-wizard-tool-");
    expect(html).toContain("Publier la version 1.1.0");
  });

  it("warns that the draft's other unpublished changes ship with it", () => {
    expect(choice(false)).not.toContain("integration-wizard-draft-changes");
    const html = choice(false, { otherDraftChanges: true });
    expect(html).toContain("integration-wizard-draft-changes");
    expect(html).toContain('href="/integrations/@org/acme"');
  });

  it("says the draft moved after a publish refused with 412, and offers the full submit again", () => {
    expect(choice(false)).not.toContain("integration-wizard-draft-moved");
    const html = choice(false, { draftMoved: true });
    expect(html).toContain("integration-wizard-draft-moved");
    expect(html).toContain("Publier la version 1.1.0");
  });

  it("offers the server's instructions as INTEGRATION.md, with the truncation warning", () => {
    const html = render(
      <ToolsChoice
        trustAll={false}
        onTrustAllChange={noop}
        proposal={{
          instructions: "# Acme\nCall search first.",
          warnings: [{ code: "instructions_truncated", message: "cut" }],
        }}
        version="1.1.0"
        onSubmit={noop}
        pending={false}
        saveError={null}
        publishError={null}
        otherDraftChanges={false}
        detailPath="/integrations/@org/acme"
      />,
    );
    expect(html).toContain(agentsFr["integrationWizard.tools.docs"]);
    expect(html).toContain(agentsFr["integrationWizard.tools.docsPreview"]);
    expect(html).toContain(agentsFr["integrationEditor.discover.warning.instructions_truncated"]);
    expect(choice(false)).not.toContain(agentsFr["integrationWizard.tools.docs"]);
  });

  it("freezes the choice while saving", () => {
    expect(radio(choice(false), "trust")).not.toContain(" disabled=");
    expect(radio(choice(false, { pending: true }), "trust")).toContain(" disabled=");
  });
});

describe("the tools step, resumed", () => {
  const source = {
    kind: "remote",
    remote: { url: "https://mcp.acme.test/mcp", transport: "streamable-http" },
  };
  const step = (draft: Record<string, unknown>, hasUnarchivedChanges: boolean) =>
    render(
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
        version="1.1.0"
        published
      />,
    );
  const draft = { name: "@org/acme", version: "1.1.0", display_name: "Acme", source };

  it("follows the server flag has_unarchived_changes: the publication ships the whole draft", () => {
    expect(step(draft, true)).toContain("integration-wizard-draft-changes");
    const clean = step(draft, false);
    expect(clean).toContain("integration-wizard-publish");
    expect(clean).not.toContain("integration-wizard-draft-changes");
  });

  it("starts on the choice an earlier save wrote", () => {
    const html = step({ ...draft, allow_undeclared_tools: true }, false);
    expect(checked(html, "trust")).toBe(true);
  });

  it("asks a caller who cannot write the home for nothing", () => {
    const html = render(
      <ToolsStep
        packageId="@org/acme"
        draft={
          { id: "@org/acme", manifest: draft, home_writable: false } as unknown as Parameters<
            typeof ToolsStep
          >[0]["draft"]
        }
        version="1.1.0"
        published
      />,
    );
    expect(html).toContain(agentsFr["integrationWizard.tools.notWritable"]);
    expect(html).not.toContain("integration-wizard-publish");
  });
});
