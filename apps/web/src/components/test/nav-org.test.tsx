// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { $api, type components } from "../../api/client.ts";
import { NavOrg } from "../nav-org.tsx";
import { orgStore } from "../../stores/org-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/" },
});

await i18nReady;
await i18n.changeLanguage("fr");

function navFor(permissions: string[]): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const org: components["schemas"]["Organization"] = {
    id: "org_nav",
    name: "Nav",
    slug: "nav",
    logo: null,
    role: "owner",
    deleting_at: null,
    permissions,
    createdAt: "2026-09-05T00:00:00Z",
  };
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: org.id,
  });
  queryClient.setQueryData(["orgs"], [org]);
  // No space to enter: the permission set is the org's, and the navigation answers at once.
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": org.id } } })
      .queryKey,
    { object: "list", hasMore: false, data: [] },
  );
  try {
    return render(
      <SidebarProvider>
        <NavOrg />
      </SidebarProvider>,
      { queryClient },
    );
  } finally {
    snapshot.mockRestore();
  }
}

describe("the main navigation", () => {
  it("draws no Construire heading over a role that reaches none of its entries", () => {
    const html = navFor(["runs:read", "files:read"]);
    expect(html).toContain("<span>Runs</span>");
    expect(html).not.toContain("Construire");
  });

  it("ends Construire with Planifications, after Intégrations, and keeps Activité for what happened", () => {
    const html = navFor([
      "agents:read",
      "skills:read",
      "integrations:read",
      "schedules:read",
      "files:read",
      "runs:read",
    ]);
    const at = (label: string) => html.indexOf(`<span>${label}</span>`);
    const order = [
      "Activité",
      "Fichiers",
      "Runs",
      "Construire",
      "Agents",
      "Skills",
      "Intégrations",
      "Planifications",
    ].map((label) =>
      label === "Activité" || label === "Construire" ? html.indexOf(label) : at(label),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
