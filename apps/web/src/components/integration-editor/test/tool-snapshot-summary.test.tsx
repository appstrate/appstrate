// SPDX-License-Identifier: Apache-2.0

/**
 * The summary above an integration's tool table, in the read view and in the package editor:
 * when the server was listed and with which connection, a truncated listing, the tools without a
 * declared permission (counted over the table it sits above), and « Relire le serveur ».
 */

import { describe, expect, it } from "bun:test";
import { installThemeEnv } from "../../../test/theme-env.ts";
import type { ToolSnapshot } from "../../../lib/integration-tool-snapshot.ts";

installThemeEnv();

const { default: i18n, i18nReady } = await import("../../../i18n.ts");
const { memberSpaceClient, renderInSpace, testSpace } =
  await import("../../../test/space-context.ts");
const { IntegrationToolsSection } = await import("../integration-tools-section.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

const REFRESH = 'data-testid="integration-tool-snapshot-refresh"';
const TRUNCATED = 'data-testid="integration-tool-snapshot-truncated"';

const summary = {
  connection_id: null,
  listed_at: "2026-11-20T10:00:00.000Z",
  added: 1,
  missing: 0,
  modified: 2,
  truncated: false,
};
const snapshot = (overrides: Partial<ToolSnapshot> = {}): ToolSnapshot => ({
  summary,
  connectionLabel: null,
  oauth: true,
  refreshBlock: null,
  ...overrides,
});
const tools = ["search", "send"].map((name) => ({
  name,
  description: "",
  status: "available" as const,
  origin: "declared" as const,
  modified: false,
}));

function view(info: ToolSnapshot | undefined, { edit = false } = {}): string {
  const queryClient = memberSpaceClient([testSpace("spc_a", ["credential-proxy:call-own"])]);
  return renderInSpace(
    <IntegrationToolsSection
      packageId="@acme/crm"
      tools={tools}
      snapshot={info}
      edit={
        edit
          ? {
              manifest: {
                auths: { primary: { type: "oauth2" } },
                tools_policy: { search: { required_scopes: { primary: ["read"] } } },
              },
              onChange: () => {},
            }
          : undefined
      }
    />,
    { overview: false, queryClient },
  );
}

describe("the tool snapshot summary", () => {
  it("states the listing without agreement to get wrong: counts after their labels", () => {
    const html = view(snapshot());
    expect(html).toContain("ajoutés : 1, disparus : 0, modifiés : 2");
  });

  it("names the connection the server was listed with", () => {
    expect(view(snapshot({ connectionLabel: "Compte de Léa" }))).toContain(
      "Connexion utilisée : Compte de Léa",
    );
    expect(view(snapshot())).not.toContain("Connexion utilisée");
  });

  it("warns that a truncated listing proves no tool gone", () => {
    expect(view(snapshot({ summary: { ...summary, truncated: true } }))).toContain(TRUNCATED);
    expect(view(snapshot())).not.toContain(TRUNCATED);
  });

  it("renders no summary for an integration whose source has no listing", () => {
    expect(view(undefined)).not.toContain("integration-tool-snapshot");
  });

  const button = (html: string) =>
    /<button[^>]*integration-tool-snapshot-refresh[^>]*>/.exec(html)?.[0] ?? "";

  it("offers « Relire le serveur » enabled, and says the read uses the published version", () => {
    const html = view(snapshot());
    expect(button(html)).not.toContain('disabled=""');
    expect(html).toContain("dernière version publiée");
  });

  it("shows the read disabled with its reason, and no hint, when it would be refused", () => {
    const html = view(snapshot({ refreshBlock: "unpublished" }));
    expect(button(html)).toContain('disabled=""');
    expect(html).toContain("Publiez une version de l’intégration");
    expect(html).not.toContain("integration-tool-snapshot-hint");
  });

  it("says the server was never read when no listing is stored", () => {
    expect(view(snapshot({ summary: null }))).toContain("Le serveur n’a pas encore été lu");
  });

  it("counts the tools without a declared permission of an OAuth integration only", () => {
    expect(view(snapshot())).toContain("2 outils sans permission déclarée");
    expect(view(snapshot({ oauth: false }))).not.toContain("sans permission déclarée");
  });

  it("shows the same summary in the editor, the counter following the draft's policy", () => {
    const html = view(snapshot(), { edit: true });
    expect(html).toContain("ajoutés : 1");
    expect(html).toContain(REFRESH);
    // `search` declares a scope in the draft: only `send` is left without one.
    expect(html).toContain("1 outil sans permission déclarée");
  });
});
