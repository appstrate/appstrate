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
