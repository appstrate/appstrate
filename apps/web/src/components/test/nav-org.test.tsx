// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import type { components } from "../../api/client.ts";
import { NavOrg } from "../nav-org.tsx";
import { memberSpaceClient, renderInSpace, testSpace } from "../../test/space-context.ts";
import { STUDIO_PERMISSION } from "../../lib/route-access.ts";
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
  spaces: ReturnType<typeof testSpace>[] = [],
  overview = false,
  url = "/",
  onClient: (queryClient: QueryClient) => void = () => {},
): string {
  // No space to enter: the permission set is the org's, and the navigation answers at once.
  const queryClient = memberSpaceClient(spaces);
  onClient(queryClient);
  const org: components["schemas"]["Organization"] = {
    id: "org_1",
    name: "Nav",
    slug: "nav",
    icon: null,
    color: null,
    role: "owner",
    deleting_at: null,
    // Synthetic: the set stands for a space's, which every preset opens the Studio in.
    permissions: [STUDIO_PERMISSION, ...permissions],
    createdAt: "2026-09-05T00:00:00Z",
  };
  queryClient.setQueryData(["orgs"], [org]);
  return renderInSpace(
    <SidebarProvider>
      <NavOrg />
    </SidebarProvider>,
    {
      overview,
      spaceId: spaces[0]?.id ?? null,
      queryClient,
      initialEntries: [url],
    },
  );
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
  // The working space reads no run; another one does.
  const spaces = [
    testSpace("spc_a", ["agents:read", "skills:read", "files:read"]),
    testSpace("spc_b", ["runs:read", "schedules:read"]),
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

  it("asks one definition of a run in flight in both modes: the runs queued or running", () => {
    // Out of the mode the working space must read runs for the Runs entry to show at all.
    const asked = (overview: boolean) => {
      let queryClient: QueryClient | undefined;
      const listed = overview
        ? spaces
        : [testSpace("spc_a", [...working, "runs:read"]), spaces[1]!];
      navFor(working, listed, overview, "/", (qc) => {
        queryClient = qc;
      });
      return queryClient!
        .getQueryCache()
        .findAll()
        .filter((query) => (query.options as { enabled?: unknown }).enabled !== false)
        .map((query) => query.queryKey);
    };
    for (const overview of [true, false]) {
      const keys = asked(overview);
      expect(keys.map((key) => key[0])).not.toContain("agents");
      const runs = keys.filter((key) => key[0] === "paginated-runs");
      expect(runs.length).toBeGreaterThan(0);
      expect(JSON.stringify(runs)).toContain("pending,running");
    }
  });
});
