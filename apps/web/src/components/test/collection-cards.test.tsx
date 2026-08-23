// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EnrichedSchedule } from "@appstrate/shared-types";
import { RunCard } from "../run-card.tsx";
import { ScheduleCard } from "../schedule-card.tsx";
import { DocumentListPanel } from "../document-list-panel.tsx";
import { ListFooter } from "../list-toolbar.tsx";
import { makeRun, render } from "./run-fixture.tsx";

function makeSchedule(overrides: Partial<EnrichedSchedule> = {}): EnrichedSchedule {
  return {
    id: "schedule_1",
    packageId: "@acme/reporter",
    userId: "user_1",
    endUserId: null,
    orgId: "org_1",
    applicationId: "app_1",
    name: "Rapport du matin",
    enabled: true,
    cron_expression: "0 7 * * *",
    timezone: "America/Toronto",
    input: null,
    config_override: null,
    generation_config_override: null,
    model_id_override: null,
    proxy_id_override: null,
    version_override: null,
    connection_overrides: null,
    dependency_overrides: null,
    last_run_at: "2026-08-22T11:00:00.000Z",
    next_run_at: "2026-08-24T11:00:00.000Z",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-22T11:00:00.000Z",
    actor_name: "Olivier Tarbès",
    actor_type: "user",
    running_runs: 1,
    unread_count: 3,
    last_run_number: 41,
    ...overrides,
  };
}

describe("the level-one collection cards", () => {
  it("draws a run from the already enriched row without losing its facts", () => {
    const html = render(<RunCard run={makeRun()} agentName="Rapport trimestriel" />);

    expect(html).toContain('href="/agents/@acme/reporter/runs/run_1"');
    expect(html).toContain("Rapport trimestriel");
    expect(html).toContain("#42");
    expect(html).toContain("Alice");
    expect(html).toContain("4.2s");
  });

  it("keeps an orphaned run visible without linking to a missing agent", () => {
    const html = render(
      <RunCard
        run={makeRun({ packageId: null, package_ephemeral: false })}
        agentName="Agent supprimé"
      />,
    );

    expect(html).not.toContain("<a ");
    expect(html).toContain("Agent supprimé");
  });

  it("gives the schedule collection variant a vertical set of comparable facts", () => {
    const html = render(
      <ScheduleCard
        schedule={makeSchedule()}
        agentName="Rapport trimestriel"
        variant="collection"
      />,
    );

    expect(html).toContain("Rapport du matin");
    expect(html).toContain("Rapport trimestriel");
    expect(html).toContain("Fréquence");
    expect(html).toContain("0 7 * * *");
    expect(html).toContain("Prochaine");
    expect(html).toContain("Olivier Tarbès");
  });

  it("leaves the existing compact schedule variant compact", () => {
    const html = render(<ScheduleCard schedule={makeSchedule()} agentName="Rapport trimestriel" />);

    expect(html).toContain("Rapport du matin");
    expect(html).not.toContain("Fréquence");
    expect(html).not.toContain("0 7 * * *");
  });

  it("keeps the honest footer on an empty document card result", () => {
    const queryClient = new QueryClient();
    const html = render(
      <QueryClientProvider client={queryClient}>
        <DocumentListPanel
          documents={[]}
          isLoading={false}
          error={null}
          empty={{ message: "Aucun résultat", compact: true }}
          display="cards"
          footer={<ListFooter count="0 document · 2.2 GB utilisés" />}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("Aucun résultat");
    expect(html).toContain("0 document · 2.2 GB utilisés");
  });
});
