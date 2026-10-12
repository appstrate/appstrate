// SPDX-License-Identifier: Apache-2.0

/**
 * A run on another model than the one chosen is told twice: before the run, as
 * a point to check on the agent's overview (the server's diagnostics, same
 * cascade as the launch), and after it, as a warning card on the run's
 * overview (the `model_fallback` marker of its journal). Neither blocks.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { AgentHealthSection } = await import("../agent-detail/agent-health-section.tsx");
const { ModelFallbackCard } = await import("../run-detail/run-warnings.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { render } = await import("../../test/render.tsx");
const { $api } = await import("../../api/client.ts");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const SPACE_ID = "spc_a";
const AGENT_PATH = "/agents/@acme/worker";

describe("the run's « Modèle remplacé » card", () => {
  it("names the model chosen, the model that served, and where to change it", () => {
    const html = render(
      <ModelFallbackCard
        chosen="Mistral local"
        used="Claude Sonnet 5"
        settingsTo={{ pathname: AGENT_PATH, search: "?agentSettings=model", hash: "#settings" }}
        cardHeaders
      />,
    );
    expect(html).toContain("Modèle remplacé");
    expect(html).toContain("Modèle choisi : Mistral local");
    expect(html).toContain("Modèle utilisé : Claude Sonnet 5");
    expect(html).toContain(`href="${AGENT_PATH}?agentSettings=model#settings"`);
  });

  it("offers no link to a reader who cannot reach the agent's settings", () => {
    const html = render(
      <ModelFallbackCard chosen="mdl_gone" used="Claude Sonnet 5" settingsTo={null} cardHeaders />,
    );
    expect(html).toContain("Modèle choisi : mdl_gone");
    expect(html).not.toContain("<a ");
  });
});

function spaceRow() {
  return {
    object: "space",
    id: SPACE_ID,
    orgId: ORG_ID,
    name: "Default",
    isDefault: true,
    settings: {},
    visibility: "open",
    default_role: "viewer",
    personal: false,
    access: "member",
    role: null,
    permissions: ["agents:read"],
    created_by: null,
    createdAt: "2026-09-05T10:00:00Z",
    updatedAt: "2026-09-05T10:00:00Z",
  };
}

function renderHealth(diagnostics: object): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    { object: "list", data: [spaceRow()], hasMore: false },
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/agents/{scope}/{name}/diagnostics", {
      params: {
        path: { scope: "@acme", name: "worker" },
        header: { "X-Org-Id": ORG_ID, "X-Application-Id": SPACE_ID },
      },
    }).queryKey,
    diagnostics,
  );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const current = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<AgentHealthSection packageId="@acme/worker" cardHeaders />, {
      queryClient,
      initialEntries: [AGENT_PATH],
    });
  } finally {
    org.mockRestore();
    current.mockRestore();
  }
}

describe("the agent's overview when its model is no longer accessible", () => {
  it("says, in French, that the next run uses the default model, and links to the model setting", () => {
    const html = renderHealth({
      status: "warning",
      blocking_count: 0,
      warning_count: 1,
      can_launch: true,
      diagnostics: [
        {
          code: "pinned_model_unavailable",
          severity: "warning",
          title: "Model unavailable",
          explanation: "The model set for this agent ('mdl_x') is no longer usable; ...",
          field: "model",
          target: { node: "model", item: null },
          correction: {
            destination: "configuration",
            section: "model",
            params: { defaultModel: "Mistral Medium" },
          },
          recoverable_on_launch: false,
        },
      ],
    });
    expect(html).toContain("1 point à vérifier");
    expect(html).toContain(
      "Le modèle de l'agent n'est plus accessible : le prochain run utilisera le modèle par défaut (Mistral Medium).",
    );
    expect(html).not.toContain("Model unavailable");
    expect(html).toContain(`href="${AGENT_PATH}?agentSettings=model#settings"`);
  });
});
