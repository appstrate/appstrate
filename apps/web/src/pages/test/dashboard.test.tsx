// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard is the fallback route, so it renders for every caller and every
 * organization — a fresh one included — and draws a section only when it holds
 * something.
 */

import { describe, expect, it, spyOn } from "bun:test";
import type { ReactElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { EnrichedSchedule } from "@appstrate/shared-types";
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

function makeSchedule(i: number, overrides: Partial<EnrichedSchedule> = {}): EnrichedSchedule {
  return {
    id: `sch_${i}`,
    packageId: "@acme/reporter",
    userId: "usr_1",
    endUserId: null,
    orgId: "org_dash",
    spaceId: "spc_1",
    name: `Planif ${i}`,
    enabled: true,
    disabled_reason: null,
    cron_expression: "0 9 * * *",
    timezone: "UTC",
    input: null,
    generation_config_override: null,
    model_id_override: null,
    proxy_id_override: null,
    version_override: null,
    connection_overrides: null,
    dependency_overrides: null,
    last_run_at: null,
    next_run_at: `2026-10-${String(15 + i).padStart(2, "0")}T09:00:00.000Z`,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    actor_name: null,
    actor_type: "user",
    running_runs: 0,
    unread_count: 0,
    last_run_number: 0,
    ...overrides,
  };
}

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

  it("counts every active schedule and lists the five that fire soonest", () => {
    // Listed latest first, so the list's order is the dashboard's own.
    const schedules = [
      ...Array.from({ length: 6 }, (_, i) => makeSchedule(6 - i)),
      makeSchedule(7, { next_run_at: null }),
      makeSchedule(8, { enabled: false }),
    ];
    const html = asOrgMember(READER, <DashboardContent {...content({ schedules })} />);
    expect(html).toContain("Planifications actives");
    expect(html).toMatch(/Planifications actives<\/span><div><p[^>]*>7<\/p>/);
    const listed = [...html.matchAll(/Planif (\d)/g)].map((m) => m[1]);
    expect(listed).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("says no run is coming when no active schedule has a next run", () => {
    const schedules = [makeSchedule(1, { next_run_at: null })];
    const html = asOrgMember(
      READER,
      <DashboardContent {...content({ runs: [run], runTotal: 1, schedules })} />,
    );
    expect(html).toMatch(/Planifications actives<\/span><div><p[^>]*>1<\/p>/);
    expect(html).toContain("Aucun run prévu");
    expect(html).not.toContain("Planifications à venir");
  });
});
