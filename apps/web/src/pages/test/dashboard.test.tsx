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
import { makeRun } from "../../test/run-fixture.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

await i18nReady;
await i18n.changeLanguage("fr");

const READER = ["runs:read", "agents:read", "schedules:read"];

function asOrgMember(
  permissions: string[],
  node: ReactElement,
  queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } }),
): string {
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
    expect(html).not.toContain("Derniers runs");
    expect(html).not.toContain("Planifications à venir");
  });

  it("draws the sections that hold something, and only those", () => {
    const html = asOrgMember(
      READER,
      <DashboardContent {...content({ runs: [run], runTotal: 1 })} />,
    );
    expect(html).not.toContain("Rien à afficher ici");
    expect(html).toContain("Derniers runs");
    expect(html).toContain("Rapporteur");
    expect(html).not.toContain("Planifications à venir");
    expect(html).not.toContain("Agents récents");
  });

  it("renders the runs it is handed, trimmed, without a query of its own for them", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    const runs = Array.from({ length: 8 }, (_, i) =>
      makeRun({ id: `run_${i}`, packageId: null, agent_name: `Agent ${i}` }),
    );
    const html = asOrgMember(
      READER,
      <DashboardContent {...content({ runs, runTotal: runs.length })} />,
      queryClient,
    );
    for (let i = 0; i < 7; i++) expect(html).toContain(`Agent ${i}`);
    expect(html).not.toContain("Agent 7");
    // A fetching list mounted under the page would register its own run query here.
    const runQueries = queryClient
      .getQueryCache()
      .findAll()
      .map((query) => JSON.stringify(query.queryKey))
      .filter((key) => key.includes("runs"));
    expect(runQueries).toEqual([]);
  });

  it("says on an agent's card how many of its runs are unread", () => {
    const agent = {
      id: "@acme/reporter",
      display_name: "Rapporteur",
      source: "local",
    } as unknown as DashboardData["agents"][number];
    const html = asOrgMember(
      READER,
      <DashboardContent {...content({ agents: [agent], unreadCounts: { [agent.id]: 3 } })} />,
    );
    expect(html).toContain('aria-label="3 runs non lus"');
  });
});
