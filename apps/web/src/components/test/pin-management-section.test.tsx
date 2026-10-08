// SPDX-License-Identifier: Apache-2.0

/**
 * An admin's per-agent pins of an integration: "Aucune connexion" pins none — so
 * it is offered even when no connection is shared to pin — and a stored pin to
 * none reads as such.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../api/client.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { PinManagementSection } from "../integration-detail/pin-management-section.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const GMAIL = "@acme/gmail";
const header = { "X-Org-Id": undefined, "X-Space-Id": undefined };
const path = { packageId: GMAIL };

const SHARED = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Équipe",
  account_id: "team@acme.test",
  auth_key: "oauth",
  shared_with_org: true,
};

function renderSection(opts: {
  pins?: { agent_package_id: string; connection_ids: string[] }[];
  connections?: (typeof SHARED)[];
}): string {
  const qc = new QueryClient();
  const keys = {
    pins: $api.queryOptions("get", "/api/integrations/{packageId}/pins", {
      params: { path, header },
    }).queryKey,
    connections: $api.queryOptions("get", "/api/integrations/{packageId}/connections", {
      params: { path, header },
    }).queryKey,
    agents: $api.queryOptions("get", "/api/integrations/{packageId}/consuming-agents", {
      params: { path, header },
    }).queryKey,
  };
  // Fixtures, not wire-complete rows: the section reads only these fields.
  const seed = (key: readonly unknown[], data: unknown[]) =>
    qc.setQueryData(key, { object: "list", data, hasMore: false });
  seed(
    keys.pins,
    (opts.pins ?? []).map((p) => ({
      ...p,
      integration_package_id: GMAIL,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    })),
  );
  seed(keys.connections, opts.connections ?? []);
  seed(keys.agents, [
    { agent_package_id: "@acme/mailer", display_name: "Mailer" },
    { agent_package_id: "@acme/triage", display_name: "Triage" },
  ]);
  return render(<PinManagementSection packageId={GMAIL} />, { queryClient: qc });
}

const t = (key: string) => i18n.t(`settings:integration.admin.pinManagement.${key}`);

describe("PinManagementSection — 'Aucune connexion'", () => {
  it("is offered beside the shared connections", () => {
    const html = renderSection({ connections: [SHARED] });
    expect(html).toContain('data-testid="pin-add-none"');
    expect(html).toContain(t("none"));
    expect(html).toContain("pin-add-connection-");
  });

  it("is offered even when no connection is shared, which only stops pinning one", () => {
    const html = renderSection({ connections: [] });
    expect(html).toContain('data-testid="pin-add-none"');
    expect(html).toContain('data-testid="pin-add-submit"');
    expect(html).toContain(t("noPinnableConnections"));
  });

  it("reads a stored pin to none as 'Aucune connexion'", () => {
    const html = renderSection({
      pins: [{ agent_package_id: "@acme/mailer", connection_ids: [] }],
      connections: [SHARED],
    });
    const row = html.match(/data-testid="pin-row-@acme\/mailer".*?<\/tr>/s)?.[0] ?? "";
    expect(row).toContain(i18n.t("agents:detail.integrationMemberPicker.none"));
  });
});
