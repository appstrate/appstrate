// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { $api, type components } from "../../api/client.ts";
import { NavOrg } from "../nav-org.tsx";
import { orgStore } from "../../stores/org-store.ts";
import { spaceStore } from "../../stores/space-store.ts";
import { authStore } from "../../stores/auth-store.ts";
import { overviewStore } from "../../stores/overview-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/" },
});

await i18nReady;
await i18n.changeLanguage("fr");

function navFor(
  permissions: string[],
  spaces: unknown[] = [],
  overview = false,
  url = "/",
  queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } }),
): string {
  const org: components["schemas"]["Organization"] = {
    id: "org_nav",
    name: "Nav",
    slug: "nav",
    icon: null,
    color: null,
    role: "owner",
    deleting_at: null,
    permissions,
    createdAt: "2026-09-05T00:00:00Z",
  };
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: org.id,
  });
  // « Tous les espaces » chosen by this reader in this org, or not.
  const chosen = [
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: "u_nav", email: "u@example.test", emailVerified: true },
    }),
    spyOn(overviewStore, "getInitialState").mockReturnValue({
      ...overviewStore.getInitialState(),
      chosen: overview ? { [`u_nav:${org.id}`]: true } : {},
    }),
  ];
  // Standing in the first space listed, as the resolver would.
  const current = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: (spaces[0] as { id?: string } | undefined)?.id ?? null,
  });
  queryClient.setQueryData(["orgs"], [org]);
  // No space to enter: the permission set is the org's, and the navigation answers at once.
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/spaces", { params: { header: { "X-Org-Id": org.id } } })
      .queryKey,
    { object: "list", hasMore: false, data: spaces },
  );
  try {
    return render(
      <SidebarProvider>
        <NavOrg />
      </SidebarProvider>,
      { queryClient, initialEntries: [url] },
    );
  } finally {
    snapshot.mockRestore();
    current.mockRestore();
    for (const stub of chosen) stub.mockRestore();
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

describe("the navigation in « Tous les espaces »", () => {
  const space = (id: string, permissions: string[]) => ({
    id,
    access: "member",
    permissions,
    personal: false,
    isDefault: id === "spc_a",
    name: id,
  });
  // The working space reads no run; another one does.
  const spaces = [
    space("spc_a", ["agents:read", "skills:read", "files:read"]),
    space("spc_b", ["runs:read", "schedules:read"]),
  ];
  const working = ["agents:read", "skills:read", "files:read"];

  it("shows the dashboard and every list some space admits, whatever the working space reads", () => {
    const html = navFor(working, spaces, true);
    for (const label of ["Dashboard", "Fichiers", "Runs", "Agents", "Skills", "Planifications"]) {
      expect(html).toContain(`<span>${label}</span>`);
    }
    // No space reads integrations.
    expect(html).not.toContain("<span>Intégrations</span>");
  });

  it("leaves the navigation of the working space as it was out of the mode", () => {
    const html = navFor(working, spaces, false);
    expect(html).toContain("<span>Agents</span>");
    expect(html).toContain("<span>Dashboard</span>");
    expect(html).not.toContain("<span>Runs</span>");
  });

  it("marks the entry a run's detail sits under, as out of the mode", () => {
    const html = navFor(working, spaces, true, "/agents/@acme/reporter/runs/run_1");
    const active = [...html.matchAll(/<a[^>]*data-active="true"[^>]*>/g)].map((m) => m[0]);
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('href="/agents"');
  });

  it("asks nothing the working space's spinner reads, which it asks out of the mode", () => {
    const asked = (overview: boolean) => {
      const queryClient = new QueryClient();
      navFor(working, spaces, overview, "/", queryClient);
      return queryClient
        .getQueryCache()
        .findAll()
        .filter((query) => (query.options as { enabled?: unknown }).enabled !== false)
        .map((query) => query.queryKey[0]);
    };
    expect(asked(true)).not.toContain("agents");
    expect(asked(true)).not.toContain("paginated-runs");
    expect(asked(false)).toContain("agents");
  });
});
