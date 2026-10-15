// SPDX-License-Identifier: Apache-2.0

/**
 * The overview's health card offers « Corriger » only where a diagnostic has a
 * place to be fixed: an agent switched off here has none, the page's band
 * above holds the switch.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { AgentHealthSection } = await import("../agent-health-section.tsx");
const { orgStore } = await import("../../../stores/org-store.ts");
const { spaceStore } = await import("../../../stores/space-store.ts");
const { render } = await import("../../../test/render.tsx");
const { $api } = await import("../../../api/client.ts");
const i18nModule = await import("../../../i18n.ts");
type AgentDiagnostic = import("../../../hooks/use-agent-diagnostics.ts").AgentDiagnostic;

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const SPACE_ID = "spc_a";

function diagnostic(code: string, field: string, section = "inputs"): AgentDiagnostic {
  return {
    code,
    severity: "blocking",
    title: code,
    explanation: code,
    field,
    target: { node: null, item: null },
    correction: { destination: "configuration", section, params: {} },
  };
}

function renderSection(diagnostics: AgentDiagnostic[]): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/agents/{scope}/{name}/diagnostics", {
      params: {
        path: { scope: "@acme", name: "worker" },
        header: { "X-Org-Id": ORG_ID, "X-Space-Id": SPACE_ID },
      },
    }).queryKey,
    {
      status: "blocking",
      blocking_count: diagnostics.length,
      warning_count: 0,
      diagnostics,
    },
  );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const space = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE_ID,
  });
  try {
    return render(<AgentHealthSection packageId="@acme/worker" />, {
      queryClient,
      initialEntries: ["/agents/@acme/worker"],
    });
  } finally {
    org.mockRestore();
    space.mockRestore();
  }
}

const FIX = ">Corriger</a>";

describe("the agent's health card", () => {
  it("offers no fix for an agent switched off here", () => {
    const html = renderSection([diagnostic("agent_not_active", "agent", "activation")]);
    expect(html).toContain(
      i18nModule.default.t("detail.diagnostics.agentNotActive.title", { ns: "agents" }),
    );
    expect(html).not.toContain(FIX);
  });

  it("CONTROL: links the fix of a diagnostic that has a place", () => {
    const html = renderSection([diagnostic("invalid_config", "config.period")]);
    expect(html).toContain('href="/agents/@acme/worker?agentSettings=inputs#settings"');
    expect(html).toContain(FIX);
  });
});
