// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's Paramètres: every rail entry opens a panel of its own, and the
 * rail's definition group is exactly the sections the definition editor serves.
 */

import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AgentDetail } from "@appstrate/shared-types";
import type { components } from "../../../api/client.ts";
import type { Versioned } from "../../../hooks/use-packages.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";

// Same environment as `settings-editing.test.tsx`.
installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
});
await import("sonner");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { documentElement: { classList: { add: () => {}, remove: () => {} } } },
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "document");
});

const { render } = await import("../../../test/render.tsx");
const { AgentSettingsView } = await import("../agent-settings-view.tsx");
const { orgKeys } = await import("../../../lib/query-keys.ts");
const { orgStore } = await import("../../../stores/org-store.ts");
const { AGENT_DEFINITION_SECTIONS } = await import("../../../lib/settings-section-href.ts");
const agentsFr = (await import("../../../locales/fr/agents.json")).default;
const i18nModule = await import("../../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG: components["schemas"]["Organization"] = {
  id: "org_a",
  name: "Acme",
  slug: "acme",
  icon: null,
  color: null,
  role: "owner",
  permissions: ["agents:read", "agents:configure", "schedules:read", "integrations:read"],
  createdAt: "2026-01-01T00:00:00Z",
  deleting_at: null,
};

const DETAIL: Versioned<AgentDetail> = {
  id: "@acme/worker",
  icon: null,
  color: null,
  source: "local",
  dependencies: { skills: [], mcp_servers: [], integrations: [] },
  input: { schema: { type: "object", properties: {} }, values: {}, locked_fields: [] },
  running_runs: 0,
  last_run: null,
  prompt: "Do the thing.",
  manifest: { name: "@acme/worker" },
  scope: "@acme",
  version: "1.0.0",
  definition: "draft",
  home_space_id: "spc_home",
  home_writable: true,
  home_deletable: false,
  home_shareable: false,
  effective_timeout_seconds: 300,
  active: true,
  etag: null,
};

/** The page with `section` asked for, to a reader every section opens to. */
function renderSection(section: string): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(orgKeys.all, [ORG]);
  // SSR reads Zustand's hydration snapshot, not its live state.
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG.id,
  });
  try {
    return render(
      <AgentSettingsView
        packageId={DETAIL.id}
        detail={DETAIL}
        isHistorical={false}
        versions={{ canRestore: false, canDelete: false }}
      />,
      { queryClient, initialEntries: [`/agents/@acme/worker?agentSettings=${section}#settings`] },
    );
  } finally {
    orgSnapshot.mockRestore();
  }
}

/** The section ids `html` links to, in order. */
const railIds = (html: string) =>
  [...html.matchAll(/href="[^"]*agentSettings=([a-z-]+)[^"]*"/g)].map((match) => match[1]!);

/** What the page shows beside the rail, past the phone menu. */
function panel(html: string): string {
  const content = html.slice(html.indexOf("</aside>"));
  return content.slice(content.indexOf("</button></div>"));
}

// The definition editor is loaded lazily: a first render starts the load.
renderSection("general");
await import("../../../pages/package-editor");
await Bun.sleep(0);

describe("agent Paramètres", () => {
  const page = renderSection("model");
  const rail = page.slice(0, page.indexOf("</aside>"));

  it("groups exactly the definition editor's sections under the definition group", () => {
    const title = agentsFr["detail.settings.definitionGroup"];
    const group = rail.slice(rail.indexOf(`>${title}<`));
    expect(railIds(group.slice(0, group.indexOf("</section>")))).toEqual([
      ...AGENT_DEFINITION_SECTIONS,
    ]);
  });

  it("opens a panel of its own for every rail entry", () => {
    const ids = railIds(rail);
    expect(ids.length).toBeGreaterThan(AGENT_DEFINITION_SECTIONS.length);
    const panels = ids.map((id) => panel(renderSection(id)));
    expect(new Set(panels).size).toBe(ids.length);
  });
});
