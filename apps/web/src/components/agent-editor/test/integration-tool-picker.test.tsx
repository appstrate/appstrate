// SPDX-License-Identifier: Apache-2.0

/**
 * The "required" switch of an integration dependency renders for every
 * integration — whatever its catalog, and before its detail has loaded — and
 * reflects the entry's `required` flag. Plus the scopes the panel shows as
 * inferred, which are the ones a run requires.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../../api/client.ts";
import i18n, { i18nReady } from "../../../i18n.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { render } from "../../../test/render.tsx";
import { memberSpaceClient, renderInSpace, testSpace } from "../../../test/space-context.ts";
import { IntegrationToolPicker } from "../integration-tool-picker.tsx";
import type { ResourceEntry } from "../types.ts";

await i18nReady;
await i18n.changeLanguage("fr");
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const ID = "@acme/gmail";

function renderPicker(entry: ResourceEntry): string {
  return render(<IntegrationToolPicker packageId={ID} entry={entry} onChange={() => {}} />);
}

describe("IntegrationToolPicker — required switch", () => {
  it("renders even when the integration detail is unavailable", () => {
    const html = renderPicker({ id: ID, version: "*" });
    expect(html).toContain(`integ-required-${ID}`);
    expect(html).toContain(i18n.t("settings:agentEditor.integrations.required.label"));
    expect(html).toContain(i18n.t("settings:agentEditor.integrations.tools.detailUnavailable"));
  });

  it("is not offered for the platform's own integration, which binds no connection", () => {
    const id = "@appstrate/platform";
    const html = render(
      <IntegrationToolPicker
        packageId={id}
        entry={{ id, version: "^1.0.0", tools: [] }}
        onChange={() => {}}
      />,
    );
    expect(html).not.toContain(`integ-required-${id}`);
  });

  it("is checked only for an entry marked required", () => {
    expect(renderPicker({ id: ID, version: "*", required: true })).toContain(
      'data-state="checked"',
    );
    expect(renderPicker({ id: ID, version: "*" })).not.toContain('data-state="checked"');
  });
});

// A run infers scopes from the tools the agent ITSELF selects: tools inherited from the
// integration's `default_tools` show as selected and require none, and a `"*"`, written or
// inherited, takes the auth's `default_scopes` instead.
describe("IntegrationToolPicker — inferred scopes", () => {
  const DETAIL_KEY = $api.queryOptions("get", "/api/integrations/{packageId}", {
    params: {
      path: { packageId: ID },
      header: { "X-Org-Id": undefined, "X-Space-Id": undefined },
    },
  }).queryKey;
  const INFERRED = `data-testid="integ-inferred-scope-${ID}-search.read"`;
  const WILDCARD_NOTICE = i18n.t("settings:agentEditor.integrations.wildcard.scopesNotice");

  /** The picker over an integration whose `search` tool requires `search.read`. */
  function renderOver(entry: Partial<ResourceEntry>, defaultTools?: string[] | "*"): string {
    const qc = new QueryClient();
    qc.setQueryData(DETAIL_KEY, {
      manifest: {
        auths: {
          primary: {
            type: "oauth2",
            default_scopes: ["base"],
            scope_catalog: [
              { value: "base", label: "Base" },
              { value: "search.read", label: "Search" },
              { value: "extra", label: "Extra" },
            ],
          },
        },
        ...(defaultTools !== undefined ? { default_tools: defaultTools } : {}),
      },
      auths: [],
      active: true,
      allow_undeclared_tools: true,
      tool_catalog: [{ name: "search", policy: { required_scopes: { primary: ["search.read"] } } }],
    });
    return render(
      <IntegrationToolPicker
        packageId={ID}
        entry={{ id: ID, version: "*", ...entry }}
        onChange={() => {}}
      />,
      { queryClient: qc },
    );
  }

  it("shows the scopes of the tools the agent selects", () => {
    expect(renderOver({ tools: ["search"] })).toContain(INFERRED);
    expect(renderOver({ tools: ["search"] }, "*")).toContain(INFERRED);
  });

  it("shows none for tools inherited from `default_tools`, which stay shown as selected", () => {
    const html = renderOver({}, ["search"]);
    expect(html).toContain('data-state="checked"');
    expect(html).not.toContain(INFERRED);
    // The agent's explicit scopes are all the run requires then.
    const pinned = renderOver({ scopes: ["extra"] }, ["search"]);
    expect(pinned).toContain(`data-testid="integ-pinned-scope-${ID}-extra"`);
    expect(pinned).not.toContain(INFERRED);
  });

  it('names the default scopes for a `"*"`, inherited as written', () => {
    for (const html of [renderOver({ tools: "*" }), renderOver({}, "*")]) {
      expect(html).toContain(WILDCARD_NOTICE);
      expect(html).not.toContain(INFERRED);
    }
    expect(renderOver({ tools: ["search"] })).not.toContain(WILDCARD_NOTICE);
  });

  it("keeps the wildcard choice and its scope notice available without any catalog", () => {
    for (const selected of [false, true]) {
      const qc = new QueryClient();
      qc.setQueryData(DETAIL_KEY, {
        manifest: { auths: {} },
        auths: [],
        active: true,
        allow_undeclared_tools: true,
        tool_catalog: [],
      });
      const html = render(
        <IntegrationToolPicker
          packageId={ID}
          entry={{ id: ID, version: "*", tools: selected ? "*" : [] }}
          onChange={() => {}}
        />,
        { queryClient: qc },
      );
      expect(html).toContain(`integ-wildcard-${ID}`);
      expect(html.includes(WILDCARD_NOTICE)).toBe(selected);
      expect(html.includes('data-state="checked"')).toBe(selected);
    }
  });
});

// A tool the space cannot serve (absent from the server, awaiting approval, blocked) is greyed and
// cannot be added; one already selected stays selected and says it will not be there at launch.
describe("IntegrationToolPicker — tool status", () => {
  // The reader is in « Atelier »; `spaceName` reads the statuses in the space « Équipe Léa ».
  const detailKey = (spaceId: string) =>
    $api.queryOptions("get", "/api/integrations/{packageId}", {
      params: { path: { packageId: ID }, header: { "X-Org-Id": "org_1", "X-Space-Id": spaceId } },
    }).queryKey;

  function renderOver(tools: string[], spaceName?: string): string {
    const qc = memberSpaceClient([
      testSpace("spc_a", ["integrations:read"]),
      testSpace("spc_lea", ["integrations:read"], "Équipe Léa"),
    ]);
    const base = { modified: false, fingerprint: null, origin: "declared" };
    qc.setQueryData(detailKey(spaceName ? "spc_lea" : "spc_a"), {
      manifest: { auths: {} },
      auths: [],
      active: true,
      allow_undeclared_tools: false,
      tool_snapshot: { listed_at: "2026-11-20T10:00:00.000Z" },
      tool_catalog: [
        { ...base, name: "ok_tool", status: "available" },
        { ...base, name: "gone_tool", status: "missing" },
        { ...base, name: "new_tool", status: "pending", origin: "listed" },
        { ...base, name: "no_tool", status: "blocked", modified: true },
      ],
    });
    return renderInSpace(
      <IntegrationToolPicker
        packageId={ID}
        spaceId={spaceName ? "spc_lea" : undefined}
        entry={{ id: ID, version: "*", tools }}
        onChange={() => {}}
      />,
      { queryClient: qc, overview: false },
    );
  }

  it("names the space the statuses are read in when it is not the current one", () => {
    const html = renderOver([], "Équipe Léa");
    expect(html).toContain("En attente d’approbation dans Équipe Léa");
    expect(html).toContain("Bloqué dans Équipe Léa");
    expect(renderOver([])).toContain("En attente d’approbation dans cet espace");
  });

  it("shows the reason of each unusable tool and disables adding it", () => {
    const html = renderOver([]);
    expect(html).toContain("En attente d’approbation dans cet espace");
    expect(html).toContain("Bloqué dans cet espace");
    expect(html).toContain("Absent du serveur à la dernière lecture (");
    expect(html).toContain(i18n.t("agents:packageTools.modified"));
    const disabled = (name: string) =>
      html
        .match(new RegExp(`<button[^>]*aria-label="Sélectionner ${name}"[^>]*>`))?.[0]
        ?.includes('disabled=""');
    // missing, pending, blocked: not addable; the usable one is.
    expect(["gone_tool", "new_tool", "no_tool"].map(disabled)).toEqual([true, true, true]);
    expect(disabled("ok_tool")).toBe(false);
    expect(html).not.toContain("tool-warning-");
  });

  it("keeps a selected unusable tool selected, with a warning", () => {
    const html = renderOver(["gone_tool"]);
    expect(html).toContain("tool-warning-gone_tool");
    expect(html).toContain(i18n.t("agents:packageTools.unavailableSelected"));
    expect(html).not.toContain("tool-warning-ok_tool");
  });
});

// A tool with no declared permission is flagged only on an OAuth integration, the one that asks
// for scopes, whatever the tool's origin.
describe("IntegrationToolPicker — unknown permissions", () => {
  const DETAIL_KEY = $api.queryOptions("get", "/api/integrations/{packageId}", {
    params: {
      path: { packageId: ID },
      header: { "X-Org-Id": undefined, "X-Space-Id": undefined },
    },
  }).queryKey;

  function renderWith(authType: string, origin = "approved"): string {
    const qc = new QueryClient();
    qc.setQueryData(DETAIL_KEY, {
      manifest: { auths: {} },
      auths: [{ auth_key: "primary", type: authType, connections: [] }],
      active: true,
      allow_undeclared_tools: false,
      tool_catalog: [
        {
          name: "extra",
          status: "available",
          origin,
          modified: false,
          fingerprint: "f",
        },
      ],
    });
    return render(
      <IntegrationToolPicker
        packageId={ID}
        entry={{ id: ID, version: "*", tools: [] }}
        onChange={() => {}}
      />,
      { queryClient: qc },
    );
  }

  it("flags them on an OAuth integration only", () => {
    const flag = i18n.t("agents:packageTools.scopesUnknown");
    expect(renderWith("oauth2")).toContain(flag);
    expect(renderWith("api_key")).not.toContain(flag);
    expect(renderWith("oauth2", "declared")).toContain(flag);
  });
});
