// SPDX-License-Identifier: Apache-2.0

/**
 * « Vue d'ensemble » over the working space: the switcher names it, the list pages and the
 * dashboard ask the org routes (which list every space the reader reaches) and nothing of the
 * working space's lists, one row per placement naming its space and linking into it, they create
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
const { DashboardPage } = await import("../dashboard.tsx");
const { PackageIndexPage } = await import("../package-index.tsx");
const { IntegrationsPage } = await import("../integrations-page.tsx");
const { makeRun } = await import("../../test/run-fixture.ts");

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
// The working space writes schedules and packages but reads no run; another space reads runs.
const SPACES = [
  space("spc_a", [
    "schedules:read",
    "schedules:write",
    "files:read",
    "agents:read",
    "agents:write",
    "agents:run",
    "agents:configure",
    "skills:read",
    "skills:write",
    "integrations:read",
    "integrations:write",
    "integrations:install",
  ]),
  space("spc_b", ["runs:read", "schedules:read", "files:read", "agents:read", "skills:read"]),
];

/** The same agent, active in both spaces: two rows, one per placement. */
const agent = (spaceId: string) => ({
  id: "@acme/reporter",
  spaceId,
  source: "local" as const,
  version: "1.0.0",
  description: "Rapporte",
  scope: "@acme",
  icon: null,
  color: null,
  display_name: "Rapporteur",
  keywords: [],
  dependencies: { integrations: {} },
  running_runs: 0,
  unread_count: 0,
  published: true,
  type: "agent" as const,
  forked_from: null,
});
const AGENTS = [agent("spc_a"), agent("spc_b")];

const packageRow = (spaceId: string, extra: Record<string, unknown> = {}) => ({
  id: "@acme/crm",
  spaceId,
  source: "local" as const,
  name: "CRM",
  description: null,
  icon: null,
  keywords: [],
  version: "1.0.0",
  scope: null,
  forked_from: null,
  created_by: null,
  created_by_name: null,
  createdAt: "2026-09-05T10:00:00Z",
  updatedAt: "2026-09-05T10:00:00Z",
  used_by_agents: 0,
  auto_installed: false,
  home_space_id: null,
  home_writable: true,
  home_deletable: true,
  home_shareable: true,
  ...extra,
});

let stubs: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const stub of stubs) stub.mockRestore();
  stubs = [];
});

function renderIn(
  overview: boolean,
  node: React.ReactElement,
  url = "/",
  seed: (queryClient: QueryClient) => void = () => {},
) {
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
  seed(queryClient);
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
  it("asks the org route, and no list of the working space", () => {
    const { asked } = renderIn(true, <RunsPage />, "/runs");
    expect(asked("paginated-runs").map((key) => key.slice(1, 3))).toEqual([
      ["org_1", "across-spaces"],
    ]);
  });

  it("offers no creation, though the working space may create schedules", () => {
    const { html, asked } = renderIn(true, <SchedulesListPage />, "/schedules");
    expect(html).not.toContain("Nouvelle planification");
    expect(asked("schedules")).toEqual([["schedules", "org_1", "across-spaces"]]);
  });

  it("is the working space's page out of the mode", () => {
    const { asked } = renderIn(false, <SchedulesListPage />, "/schedules");
    expect(asked("schedules")).toEqual([["schedules", "org_1", "spc_a"]]);
  });
});

describe("the agent index in the mode", () => {
  const seed = (queryClient: QueryClient) =>
    queryClient.setQueryData(["agents", "org_1", "across-spaces"], AGENTS);

  it("asks the org route only, and draws one row per placement linking into its space", () => {
    const { html, asked } = renderIn(true, <PackageIndexPage type="agent" />, "/agents", seed);
    expect(asked("agents")).toEqual([["agents", "org_1", "across-spaces"]]);
    expect(html).toContain('href="/agents/@acme/reporter"');
    expect(html).toContain('href="/agents/@acme/reporter?enterSpace=spc_b"');
    // The « Espace » column names each row's space.
    expect(html).toContain(">Espace<");
    expect(html).toContain("Studio");
  });

  it("offers no creation, import, catalogue nor run, though the working space may do all four", () => {
    const { html } = renderIn(true, <PackageIndexPage type="agent" />, "/agents", seed);
    expect(html).not.toContain("data-page-actions-trigger");
    expect(html).not.toContain("Nouvel agent");
    expect(html).not.toContain('aria-label="Lancer"');
  });

  it("is the working space's page out of the mode", () => {
    const { html, asked } = renderIn(false, <PackageIndexPage type="agent" />, "/agents");
    expect(asked("agents")).toEqual([["agents", "org_1", "spc_a"]]);
    expect(html).toContain("data-page-actions-trigger");
    expect(html).not.toContain(">Espace<");
  });

  it("says the list is empty across the spaces, offering no creation", () => {
    const { html } = renderIn(true, <PackageIndexPage type="agent" />, "/agents", (qc) =>
      qc.setQueryData(["agents", "org_1", "across-spaces"], []),
    );
    expect(html).toContain("Aucun agent actif dans vos espaces.");
    expect(html).not.toContain("Nouvel agent");
  });
});

describe("the skill index in the mode", () => {
  it("asks the org route of its type and links each placement into its space", () => {
    const { html, asked } = renderIn(true, <PackageIndexPage type="skill" />, "/skills", (qc) =>
      qc.setQueryData(
        ["packages", "skills", "org_1", "across-spaces"],
        [packageRow("spc_a"), packageRow("spc_b")],
      ),
    );
    expect(asked("packages")).toEqual([["packages", "skills", "org_1", "across-spaces"]]);
    expect(html).toContain('href="/skills/@acme/crm"');
    expect(html).toContain('href="/skills/@acme/crm?enterSpace=spc_b"');
    expect(html).not.toContain("data-page-actions-trigger");
  });
});

describe("the integration index in the mode", () => {
  const seed = (queryClient: QueryClient) => {
    queryClient.setQueryData(
      ["packages", "integrations", "org_1", "across-spaces"],
      [
        packageRow("spc_a", { source_kind: "remote", server: null }),
        packageRow("spc_b", { source_kind: "remote", server: null }),
      ],
    );
    // The caller's connections: one org-scoped, one in the second space only.
    queryClient.setQueryData(["get", "/api/me/connections", {}], {
      object: "list",
      data: [
        {
          source_id: "@acme/crm",
          connections: [
            { org: { id: "org_1" }, space: null },
            { org: { id: "org_1" }, space: { id: "spc_b" } },
          ],
        },
      ],
    });
  };

  it("draws a card per placement, naming its space and counting the connections there", () => {
    const { html, asked } = renderIn(true, <IntegrationsPage />, "/integrations", seed);
    expect(asked("packages")).toEqual([["packages", "integrations", "org_1", "across-spaces"]]);
    expect(html).toContain('href="/integrations/@acme/crm"');
    expect(html).toContain('href="/integrations/@acme/crm?enterSpace=spc_b"');
    expect(html).toContain("Studio · 1 connexion");
    expect(html).toContain("spc_b · 2 connexions");
    expect(html).not.toContain("data-page-actions-trigger");
  });
});

describe("the dashboard in the mode", () => {
  const seed = (queryClient: QueryClient) => {
    queryClient.setQueryData(["agents", "org_1", "across-spaces"], AGENTS);
    queryClient.setQueryData(
      [
        "paginated-runs",
        "org_1",
        "across-spaces",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        15,
        0,
      ],
      {
        data: [
          makeRun({ id: "run_b", spaceId: "spc_b", packageId: "@acme/reporter" }),
          makeRun({ id: "run_a", spaceId: "spc_a", packageId: "@acme/reporter" }),
        ],
        total: 2,
      },
    );
    queryClient.setQueryData(["schedules", "org_1", "across-spaces"], []);
  };

  it("reads its three lists from the org routes, nothing of the working space", () => {
    const { asked } = renderIn(true, <DashboardPage />, "/", seed);
    expect(asked("agents")).toEqual([["agents", "org_1", "across-spaces"]]);
    expect(asked("schedules")).toEqual([["schedules", "org_1", "across-spaces"]]);
    expect(asked("paginated-runs").map((key) => key.slice(1, 3))).toEqual([
      ["org_1", "across-spaces"],
    ]);
  });

  it("draws an agent once per space, each card and run linking into its space", () => {
    const { html } = renderIn(true, <DashboardPage />, "/", seed);
    expect(html).toContain('href="/agents/@acme/reporter?enterSpace=spc_b"');
    expect(html).toContain('href="/agents/@acme/reporter"');
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_b?enterSpace=spc_b"');
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_a"');
  });

  it("offers neither the assistant nor a run", () => {
    const { html } = renderIn(true, <DashboardPage />, "/", seed);
    expect(html).not.toContain("Demander à l’IA");
    expect(html).not.toContain('aria-label="Lancer"');
    // Out of the mode, the working space's dashboard offers the assistant.
    expect(renderIn(false, <DashboardPage />, "/").html).toContain("Demander à l’IA");
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
