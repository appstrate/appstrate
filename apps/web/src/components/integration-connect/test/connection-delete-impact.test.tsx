// SPDX-License-Identifier: Apache-2.0

/**
 * The delete confirmation says which of the caller's agents and schedules lose
 * the connection, and what each keeps: fewer connections, or none (back to the
 * usual resolution).
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type paths } from "../../../api/client.ts";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { ConnectionDeleteImpact } from "../connection-delete-impact.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const CONNECTION = "33333333-3333-4333-8333-333333333333";

type Impact =
  paths["/api/me/connections/{connectionId}/delete-impact"]["get"]["responses"][200]["content"]["application/json"];

function renderWith(impact: Impact): string {
  const qc = new QueryClient();
  const { queryKey } = $api.queryOptions(
    "get",
    "/api/me/connections/{connectionId}/delete-impact",
    { params: { path: { connectionId: CONNECTION } } },
  );
  qc.setQueryData(queryKey, impact);
  return render(<ConnectionDeleteImpact connectionId={CONNECTION} />, { queryClient: qc });
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
        },
        {
          scheduleId: "sched_b",
          schedule_name: null,
          agent_package_id: "@acme/audit",
          agent_display_name: "Audit",
          integration_package_id: "@acme/ssh",
          connection_count: 1,
        },
      ],
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
  });

  it("renders nothing when the delete rewrites none of the caller's references", () => {
    expect(renderWith({ pins: [], schedules: [] })).not.toContain(
      'data-testid="connection-delete-impact"',
    );
  });
});
