// SPDX-License-Identifier: Apache-2.0

/**
 * The delete confirmation says which agents lose the connection, and what each
 * keeps: fewer connections, or none (back to the default resolution).
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../../api/client.ts";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { ConnectionPinImpact } from "../connection-pin-impact.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const CONNECTION = "33333333-3333-4333-8333-333333333333";

function renderWith(
  pins: {
    agent_package_id: string;
    agent_display_name: string;
    integration_package_id: string;
    connection_count: number;
  }[],
): string {
  const qc = new QueryClient();
  const { queryKey } = $api.queryOptions("get", "/api/me/connections/{connectionId}/pins", {
    params: { path: { connectionId: CONNECTION } },
  });
  qc.setQueryData(queryKey, { object: "list", data: pins, hasMore: false });
  return render(<ConnectionPinImpact connectionId={CONNECTION} />, { queryClient: qc });
}

describe("ConnectionPinImpact", () => {
  it("names each agent and what its selection becomes", () => {
    const html = renderWith([
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
    ]);
    expect(html).toContain(i18n.t("settings:connections.pinImpact.intro", { count: 2 }));
    expect(html).toContain("Ops multi");
    expect(html).toContain(i18n.t("settings:connections.pinImpact.shrinks", { count: 2, from: 3 }));
    expect(html).toContain("Audit");
    expect(html).toContain(i18n.t("settings:connections.pinImpact.resets"));
  });

  it("renders nothing when no agent of the caller pins the connection", () => {
    expect(renderWith([])).not.toContain('data-testid="connection-pin-impact"');
  });
});
