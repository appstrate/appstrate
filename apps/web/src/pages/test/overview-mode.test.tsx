// SPDX-License-Identifier: Apache-2.0

/**
 * « Vue d'ensemble » over the working space: the switcher names it, the list pages ask the org
 * route with every admitting space and nothing of the working space's lists, they create
 * nothing, and the gate opens a list another space admits. Out of the mode, nothing changes.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { render } = await import("../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { RunsPage } = await import("../runs-page.tsx");
const { SchedulesListPage } = await import("../schedules-list.tsx");
const { RouteGate } = await import("../../components/route-gate.tsx");
const { OrgSwitcher } = await import("../../components/org-switcher.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");

await i18nReady;
await i18n.changeLanguage("fr");

const space = (id: string, permissions: string[]) => ({
  id,
  object: "space",
  access: "member",
  permissions,
  personal: false,
  isDefault: id === "spc_a",
  name: id === "spc_a" ? "Studio" : id,
  role: null,
});
// The working space writes schedules but reads no run; another space reads runs.
const SPACES = [
  space("spc_a", ["schedules:read", "schedules:write", "files:read"]),
  space("spc_b", ["runs:read", "schedules:read", "files:read"]),
];

let stubs: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const stub of stubs) stub.mockRestore();
  stubs = [];
});

function renderIn(overview: boolean, node: React.ReactElement, url = "/") {
  stubs = [
    spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: "org_1",
    }),
    spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: "spc_a",
    }),
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: "u_1", email: "u@example.test", emailVerified: true },
    }),
    spyOn(overviewStore, "getInitialState").mockReturnValue({
      ...overviewStore.getInitialState(),
      chosen: overview ? { "u_1:org_1": true } : {},
    }),
  ];
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: "org_1",
        name: "Acme",
        slug: "acme",
        icon: null,
        color: null,
        role: "member",
        deleting_at: null,
        permissions: [],
        createdAt: "2026-09-05T00:00:00Z",
      },
    ],
  );
  queryClient.setQueryData(
    ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }],
    {
      object: "list",
      hasMore: false,
      data: SPACES,
    },
  );
  const html = render(<SidebarProvider>{node}</SidebarProvider>, {
    queryClient,
    initialEntries: [url],
  });
  /** The list queries allowed to send a request. */
  const asked = (root: string) =>
    queryClient
      .getQueryCache()
      .findAll({ queryKey: [root] })
      .filter((query) => (query.options as { enabled?: unknown }).enabled !== false)
      .map((query) => query.queryKey);
  return { html, asked };
}

describe("the switcher", () => {
  it("names « Vue d'ensemble » where it names the working space, while the mode is on", () => {
    expect(renderIn(true, <OrgSwitcher variant="brand" />).html).toContain("Vue d'ensemble");
    const off = renderIn(false, <OrgSwitcher variant="brand" />).html;
    expect(off).not.toContain("Vue d'ensemble");
    expect(off).toContain("Studio");
  });

  it("names the organization and the space, or the mode, in its accessible name", () => {
    expect(renderIn(true, <OrgSwitcher variant="brand" />).html).toContain(
      "aria-label=\"Changer d'organisation ou d'espace (actuel : Acme, Vue d'ensemble)\"",
    );
    expect(renderIn(false, <OrgSwitcher variant="brand" />).html).toContain(
      "aria-label=\"Changer d'organisation ou d'espace (actuel : Acme, Studio)\"",
    );
  });

  it("puts its tile in the space's slot, in the sidebar and the phone header alike", () => {
    for (const variant of ["brand", "mobile"] as const) {
      expect(renderIn(true, <OrgSwitcher variant={variant} />).html).toContain(
        'data-testid="overview-tile"',
      );
      expect(renderIn(false, <OrgSwitcher variant={variant} />).html).not.toContain(
        'data-testid="overview-tile"',
      );
    }
  });
});

describe("a list page in the mode", () => {
  it("asks the org route with every space admitting runs, and no list of the working space", () => {
    const { asked } = renderIn(true, <RunsPage />, "/runs");
    expect(asked("paginated-runs").map((key) => key.slice(1, 4))).toEqual([
      ["org_1", "/orgs/runs", "spc_b"],
    ]);
  });

  it("offers no creation, though the working space may create schedules", () => {
    const { html, asked } = renderIn(true, <SchedulesListPage />, "/schedules");
    expect(html).not.toContain("Nouvelle planification");
    expect(asked("schedules")).toEqual([["schedules", "org_1", "/orgs/schedules", "spc_a,spc_b"]]);
  });

  it("is the working space's page out of the mode", () => {
    const { asked } = renderIn(false, <SchedulesListPage />, "/schedules");
    expect(asked("schedules")).toEqual([["schedules", "org_1", "spc_a"]]);
  });
});

describe("the gate", () => {
  const gate = (
    <RouteGate path="/runs" pending={<p>attente</p>}>
      <p>ouvert</p>
    </RouteGate>
  );

  it("opens a list another space admits, in the mode", () => {
    expect(renderIn(true, gate, "/runs").html).toContain("ouvert");
  });

  it("judges it by the working space out of the mode", () => {
    expect(renderIn(false, gate, "/runs").html).not.toContain("ouvert");
  });

  it("waits while a link enters another space, never judging on the previous one", () => {
    const html = renderIn(false, gate, "/runs?enterSpace=spc_b").html;
    expect(html).toContain("attente");
    expect(html).not.toContain("ouvert");
  });
});
