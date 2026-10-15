// SPDX-License-Identifier: Apache-2.0

/**
 * An admin's per-agent pins of an integration: "Aucune connexion" pins none — so
 * it is offered even when no connection is shared to pin (in the form that opens
 * behind "Ajouter") — and a stored pin to none reads as such.
 */

import { describe, expect, it, spyOn } from "bun:test";
import type { ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../api/client.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { spaceStore } from "../../stores/space-store.ts";
import { NewPinForm, PinManagementSection } from "../integration-detail/pin-management-section.tsx";
import { descriptionOf, menuItems, type MenuItem } from "../../test/connection-menu-tree.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const GMAIL = "@acme/gmail";
const SPACE = "spc_here";
const header = { "X-Org-Id": undefined, "X-Space-Id": SPACE };
const path = { packageId: GMAIL };

const SHARED = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Équipe",
  account_id: "team@acme.test",
  auth_key: "oauth",
  scope: "org" as const,
  spaceId: null,
  shared_here: true,
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
  // SSR reads Zustand's hydration snapshot: only shared-into-this-space rows are pinnable.
  const space = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE,
  });
  try {
    return render(<PinManagementSection packageId={GMAIL} />, { queryClient: qc });
  } finally {
    space.mockRestore();
  }
}

function Form({
  connections,
  onItems,
}: {
  connections: (typeof SHARED)[];
  onItems: (items: Map<string, MenuItem>) => void;
}) {
  const tree: ReactNode = NewPinForm({
    packageId: GMAIL,
    agents: [{ agent_package_id: "@acme/mailer", display_name: "Mailer" }],
    connections: connections as never,
    onDone: () => {},
  });
  onItems(menuItems(tree));
  return null;
}

/** The form behind "Ajouter", with the connections shared into the space: the items of its menu. */
function formItems(connections: (typeof SHARED)[]): Map<string, MenuItem> {
  let items = new Map<string, MenuItem>();
  render(<Form connections={connections} onItems={(found) => (items = found)} />, {
    queryClient: new QueryClient(),
  });
  return items;
}

/** The form rendered closed, as the page shows it. */
function renderForm(connections: (typeof SHARED)[]): string {
  return render(
    <NewPinForm
      packageId={GMAIL}
      agents={[{ agent_package_id: "@acme/mailer", display_name: "Mailer" }]}
      connections={connections as never}
      onDone={() => {}}
    />,
    { queryClient: new QueryClient() },
  );
}

const t = (key: string) => i18n.t(`settings:integration.admin.pinManagement.${key}`);

describe("PinManagementSection, 'Aucune connexion'", () => {
  it("is a mode of the connection menu, beside the shared connections", () => {
    const items = formItems([SHARED]);
    expect(items.get("pin-add-pick-none-connections")).toMatchObject({ value: "none" });
    expect(items.get("pin-add-pick-choose-connections")).toMatchObject({ value: "choose" });
    expect(items.has(`pin-add-pick-option-${SHARED.id}`)).toBe(true);
    // An exception to the default: « Hériter » is the pin's absence, which the table's delete does.
    expect(items.has("pin-add-pick-reset-connections")).toBe(false);
    expect(renderForm([SHARED])).toContain("pin-add-pick-connections");
  });

  it("says both outcomes, since the agent may require the integration", async () => {
    const hint = () =>
      descriptionOf(formItems([SHARED]).get("pin-add-pick-none-connections")?.children);
    expect(hint()).toBe("L'agent s'exécute sans cette intégration, ou ne démarre pas s'il l'exige");
    await i18n.changeLanguage("en");
    try {
      expect(hint()).toBe(
        "The agent runs without this integration, or does not start if it requires it",
      );
    } finally {
      // The i18n instance is shared by the whole process: never leave English behind.
      await i18n.changeLanguage("fr");
    }
  });

  it("is offered even when no connection is shared, which only stops pinning one", () => {
    const items = formItems([]);
    expect(items.has("pin-add-pick-none-connections")).toBe(true);
    const html = renderForm([]);
    expect(html).toContain('data-testid="pin-add-submit"');
    expect(html).toContain(t("noPinnableConnections"));
  });

  it("reads a stored pin to none as 'Aucune connexion'", () => {
    const html = renderSection({
      pins: [{ agent_package_id: "@acme/mailer", connection_ids: [] }],
      connections: [SHARED],
    });
    const row = html.match(/<tr[^>]*>(?:(?!<\/tr>).)*Mailer.*?<\/tr>/s)?.[0] ?? "";
    expect(row).toContain(i18n.t("agents:detail.integrationMemberPicker.none"));
  });
});
