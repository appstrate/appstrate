// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard is the fallback route, so it renders for every caller and every
 * organization — a fresh one included — and draws a section only when it holds
 * something.
 */

import { describe, expect, it, spyOn } from "bun:test";
import type { ReactElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/client.ts";
import { DashboardContent, type DashboardData } from "../dashboard-content.tsx";
import { orgStore } from "../../stores/org-store.ts";
import { render } from "../../test/render.tsx";
import { makeRun } from "../../components/test/run-fixture.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

await i18nReady;
await i18n.changeLanguage("fr");

const READER = ["runs:read", "agents:read", "schedules:read"];

function asOrgMember(permissions: string[], node: ReactElement): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const org: components["schemas"]["Organization"] = {
    id: "org_dash",
    name: "Dash",
    slug: "dash",
    logo: null,
    role: "member",
    deleting_at: null,
    permissions,
    createdAt: "2026-09-05T00:00:00Z",
  };
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: org.id,
  });
  queryClient.setQueryData(["orgs"], [org]);
  try {
    return render(node, { queryClient });
  } finally {
    snapshot.mockRestore();
  }
}

function content(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    firstName: "Ada",
    agents: [],
    runs: [],
    runTotal: 0,
    schedules: [],
    agentName: (run) => run.agent_name ?? run.id,
    ...overrides,
  };
}

const run = makeRun({ packageId: null, agent_name: "Rapporteur" });

describe("the dashboard", () => {
  it("tells a fresh organization there is nothing yet, with no zero cards or empty boxes", () => {
    const html = asOrgMember(READER, <DashboardContent {...content()} />);
    expect(html).toContain("Rien à afficher ici");
    expect(html).not.toContain("Réussite des derniers runs");
    expect(html).not.toContain("Exécutions récentes");
    expect(html).not.toContain("Planifications à venir");
  });

  it("draws the sections that hold something, and only those", () => {
    const html = asOrgMember(
      READER,
      <DashboardContent {...content({ runs: [run], runTotal: 1 })} />,
    );
    expect(html).not.toContain("Rien à afficher ici");
    expect(html).toContain("Exécutions récentes");
    expect(html).toContain("Rapporteur");
    expect(html).not.toContain("Planifications à venir");
    expect(html).not.toContain("Agents récents");
  });
});
