// SPDX-License-Identifier: Apache-2.0

/**
 * The delete confirmation says which of the caller's agents and schedules lose
 * the connection, and what each keeps: fewer connections, or none (back to the
 * usual resolution) — or, for an enabled schedule left with none, that it is
 * disabled — and how many schedules of other people it disables, unnamed. Until the
 * impact arrives it says it is checking; a failed check says so.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type paths } from "../../../api/client.ts";
import { ApiError } from "../../../api/errors.ts";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { ConnectionDeleteImpact } from "../connection-delete-impact.tsx";
import { useConnectionDeleteImpact } from "../../../hooks/use-me-connections.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const CONNECTION = "33333333-3333-4333-8333-333333333333";

type Impact =
  paths["/api/me/connections/{connectionId}/delete-impact"]["get"]["responses"][200]["content"]["application/json"];

function Harness() {
  const impact = useConnectionDeleteImpact(CONNECTION);
  return <ConnectionDeleteImpact impact={impact} />;
}

function renderWith(impact: Impact): string {
  const qc = new QueryClient();
  const { queryKey } = $api.queryOptions(
    "get",
    "/api/me/connections/{connectionId}/delete-impact",
    { params: { path: { connectionId: CONNECTION } } },
  );
  qc.setQueryData(queryKey, impact);
  return render(<Harness />, { queryClient: qc });
}

describe("ConnectionDeleteImpact", () => {
  it("names each agent and what its selection becomes", () => {
    const html = renderWith({
      pins: [
        {
          agent_package_id: "@acme/ops",
          agent_display_name: "Ops multi",
          integration_package_id: "@acme/ssh",
          connection_count: 3,
        },
        {
          agent_package_id: "@acme/audit",
          agent_display_name: "Audit",
          integration_package_id: "@acme/ssh",
          connection_count: 1,
        },
      ],
      schedules: [],
      other_schedules_disabled_count: 0,
    });
    expect(html).toContain(i18n.t("settings:connections.pinImpact.intro", { count: 2 }));
    expect(html).toContain("Ops multi");
    expect(html).toContain(i18n.t("settings:connections.pinImpact.shrinks", { count: 2, from: 3 }));
    expect(html).toContain("Audit");
    expect(html).toContain(i18n.t("settings:connections.pinImpact.resets"));
    expect(html).not.toContain(i18n.t("settings:connections.scheduleImpact.intro", { count: 1 }));
  });

  it("names each schedule and what its override becomes", () => {
    const html = renderWith({
      pins: [],
      schedules: [
        {
          scheduleId: "sched_a",
          schedule_name: "Rapport du lundi",
          agent_package_id: "@acme/ops",
          agent_display_name: "Ops multi",
          integration_package_id: "@acme/ssh",
          connection_count: 2,
          disables: false,
        },
        {
          scheduleId: "sched_b",
          schedule_name: null,
          agent_package_id: "@acme/audit",
          agent_display_name: "Audit",
          integration_package_id: "@acme/ssh",
          connection_count: 1,
          disables: false,
        },
      ],
      other_schedules_disabled_count: 0,
    });
    expect(html).toContain(i18n.t("settings:connections.scheduleImpact.intro", { count: 2 }));
    expect(html).toContain("Rapport du lundi");
    expect(html).toContain(
      i18n.t("settings:connections.scheduleImpact.shrinks", { count: 1, from: 2 }),
    );
    expect(html).toContain(i18n.t("settings:connections.scheduleImpact.unnamed"));
    expect(html).toContain("(Audit)");
    expect(html).toContain(i18n.t("settings:connections.scheduleImpact.resets"));
    expect(html).not.toContain(i18n.t("settings:connections.pinImpact.intro", { count: 1 }));
    expect(html).not.toContain(i18n.t("settings:connections.scheduleImpact.disables"));
  });

  it("says an enabled schedule the delete leaves with no connection is disabled", () => {
    const html = renderWith({
      pins: [],
      schedules: [
        {
          scheduleId: "sched_c",
          schedule_name: "Veille",
          agent_package_id: "@acme/ops",
          agent_display_name: "Ops multi",
          integration_package_id: "@acme/ssh",
          connection_count: 1,
          disables: true,
        },
      ],
      other_schedules_disabled_count: 0,
    });
    expect(html).toContain("Veille");
    expect(html).toContain("(Ops multi)");
    expect(html).toContain(i18n.t("settings:connections.scheduleImpact.disables"));
    expect(html).not.toContain(i18n.t("settings:connections.scheduleImpact.resets"));
  });

  it("counts other people's schedules the delete disables, naming none of them", () => {
    const html = renderWith({ pins: [], schedules: [], other_schedules_disabled_count: 2 });
    expect(html).toContain('data-testid="connection-delete-impact"');
    expect(html).toContain(
      i18n.t("settings:connections.scheduleImpact.othersDisabled", { count: 2 }),
    );
    expect(html).not.toContain(i18n.t("settings:connections.scheduleImpact.intro", { count: 2 }));
  });

  it("renders nothing when the delete rewrites none of the caller's references", () => {
    expect(
      renderWith({ pins: [], schedules: [], other_schedules_disabled_count: 0 }),
    ).not.toContain('data-testid="connection-delete-impact"');
  });

  it("says it is checking until the impact arrives", () => {
    const html = render(<Harness />, { queryClient: new QueryClient() });
    expect(html).toContain('data-testid="connection-delete-impact-loading"');
    expect(html).toContain(i18n.t("settings:connections.deleteImpact.loading"));
  });

  it("says the check failed when the impact cannot be read", () => {
    const html = render(
      <ConnectionDeleteImpact
        impact={{ data: undefined, error: new ApiError("internal_error", "boom", 500) }}
      />,
    );
    expect(html).toContain('data-testid="connection-delete-impact-error"');
    expect(html).toContain(i18n.t("settings:connections.deleteImpact.error"));
  });
});
