// SPDX-License-Identifier: Apache-2.0

/**
 * « Vue d'ensemble » over the working space: the switcher names it, the list pages and the
 * dashboard ask the org routes (which list every space the reader reaches) and nothing of the
 * working space's lists, one row per placement naming its space and linking into it, and the gate
 * opens a list another space admits. Nothing is hidden by the mode: a row acts in its own space,
 * by that space's grants, and an action naming no space is offered where some space grants it.
 * Out of the mode, nothing changes.
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
const { FilesPage } = await import("../files.tsx");
const { fileFixture } = await import("../../test/render.tsx");
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

/** The same agent, active in both spaces: the org route's two rows, one per space. */
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
  spaces: readonly ReturnType<typeof space>[] = SPACES,
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
      data: spaces,
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

  it("names the mode under the organization without a space badge, in the sidebar and the phone header alike", () => {
    for (const variant of ["brand", "mobile"] as const) {
      const on = renderIn(true, <OrgSwitcher variant={variant} />).html;
      expect(on).toContain('title="Vue d\'ensemble"');
      expect(on).not.toContain("-bottom-1");
      const off = renderIn(false, <OrgSwitcher variant={variant} />).html;
      expect(off).toContain('title="Studio"');
      expect(off).toContain("-bottom-1");
    }
  });
});

describe("a list page in the mode", () => {
  it("asks the org route, its unread count included, and no list of the working space", () => {
    const { asked } = renderIn(true, <RunsPage />, "/runs");
    const scopes = asked("paginated-runs").map((key) => key.slice(1, 3));
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every(([org, scope]) => org === "org_1" && scope === "across-spaces")).toBe(true);
  });

  it("offers « Tout marquer comme lu », as out of the mode", () => {
    expect(renderIn(true, <RunsPage />, "/runs").html).toContain("data-page-actions-trigger");
    expect(renderIn(false, <RunsPage />, "/runs").html).toContain("data-page-actions-trigger");
  });

  it("offers the creation a space grants, the list asking every space", () => {
    const { html, asked } = renderIn(true, <SchedulesListPage />, "/schedules");
    expect(html).toContain("data-page-actions-trigger");
    expect(asked("schedules")).toEqual([["schedules", "org_1", "across-spaces"]]);
  });

  it("offers no creation where no space grants it", () => {
    const readers = SPACES.map((s) => ({
      ...s,
      permissions: s.permissions.filter((p) => p !== "schedules:write"),
    }));
    const { html } = renderIn(true, <SchedulesListPage />, "/schedules", () => {}, readers);
    expect(html).not.toContain("data-page-actions-trigger");
  });

  it("says the schedules are empty across the spaces, offering the creation", () => {
    const empty = (overview: boolean) =>
      renderIn(overview, <SchedulesListPage />, "/schedules", (qc) =>
        qc.setQueryData(
          overview ? ["schedules", "org_1", "across-spaces"] : ["schedules", "org_1", "spc_a"],
          [],
        ),
      ).html;
    expect(empty(true)).toContain("Aucune planification dans vos espaces.");
    expect(empty(true)).toContain("Nouvelle planification");
    expect(empty(false)).toContain("Nouvelle planification");
  });

  it("is the working space's page out of the mode", () => {
    const { asked } = renderIn(false, <SchedulesListPage />, "/schedules");
    expect(asked("schedules")).toEqual([["schedules", "org_1", "spc_a"]]);
  });
});

describe("the agent index in the mode", () => {
  const seed = (queryClient: QueryClient) =>
    queryClient.setQueryData(["agents", "org_1", "across-spaces"], AGENTS);

  /** The table's body rows. */
  const rowsOf = (html: string) => html.split("<tr").slice(2);

  it("asks the org route only, and draws an agent of two spaces once, naming both", () => {
    const { html, asked } = renderIn(true, <PackageIndexPage type="agent" />, "/agents", seed);
    expect(asked("agents")).toEqual([["agents", "org_1", "across-spaces"]]);
    expect(rowsOf(html)).toHaveLength(1);
    // The row opens in its first space, the working one here.
    expect(html).toContain('href="/agents/@acme/reporter"');
    expect(html).not.toContain("enterSpace=");
    // The « Espace » column names the first space and counts the other, named in its title.
    expect(html).toContain(">Espace<");
    expect(html).toMatch(/title="Studio">Studio<\/span><span[^>]*title="spc_b">\+1<\/span>/);
    expect(html).toContain("1 élément");
  });

  it("offers a row's run where one of its spaces grants it, whatever the working space grants", () => {
    const run = (spaces: typeof SPACES) =>
      renderIn(true, <PackageIndexPage type="agent" />, "/agents", seed, spaces).html.includes(
        'aria-label="Lancer"',
      );
    const without = (space: (typeof SPACES)[number]) => ({
      ...space,
      permissions: space.permissions.filter((p) => p !== "agents:run"),
    });
    // spc_a grants `agents:run`, spc_b does not.
    expect(run(SPACES)).toBe(true);
    // Granted in the other space only: the run follows the row's spaces, not the working one.
    expect(
      run([
        without(SPACES[0]!),
        { ...SPACES[1]!, permissions: [...SPACES[1]!.permissions, "agents:run"] },
      ]),
    ).toBe(true);
    expect(run([without(SPACES[0]!), SPACES[1]!])).toBe(false);
  });

  it("offers no write while the space listing has not answered: it appears once, never flips", () => {
    const { html } = renderIn(true, <PackageIndexPage type="agent" />, "/agents", (qc) => {
      qc.removeQueries({ queryKey: ["get", "/api/spaces"] });
      qc.setQueryData(["agents", "org_1", "spc_a"], [agent("spc_a")]);
    });
    expect(html).not.toContain("data-page-actions-trigger");
    expect(html).not.toContain('aria-label="Lancer"');
  });

  it("offers the creation, import and catalogue a space grants", () => {
    const { html } = renderIn(true, <PackageIndexPage type="agent" />, "/agents", seed);
    expect(html).toContain("data-page-actions-trigger");
  });

  it("is the working space's page out of the mode", () => {
    const { html, asked } = renderIn(false, <PackageIndexPage type="agent" />, "/agents");
    expect(asked("agents")).toEqual([["agents", "org_1", "spc_a"]]);
    expect(html).toContain("data-page-actions-trigger");
    expect(html).not.toContain(">Espace<");
  });

  it("says the list is empty across the spaces, offering the creation", () => {
    const { html } = renderIn(true, <PackageIndexPage type="agent" />, "/agents", (qc) =>
      qc.setQueryData(["agents", "org_1", "across-spaces"], []),
    );
    expect(html).toContain("Aucun agent actif dans vos espaces.");
    expect(html).toContain("Nouvel agent");
  });
});

describe("the skill index in the mode", () => {
  it("asks the org route of its type and draws a skill of two spaces once", () => {
    const { html, asked } = renderIn(true, <PackageIndexPage type="skill" />, "/skills", (qc) =>
      qc.setQueryData(
        ["packages", "skills", "org_1", "across-spaces"],
        [packageRow("spc_a"), packageRow("spc_b")],
      ),
    );
    expect(asked("packages")).toEqual([["packages", "skills", "org_1", "across-spaces"]]);
    expect(html).toContain('href="/skills/@acme/crm"');
    expect(html).not.toContain("enterSpace=");
    expect(html).toContain("1 élément");
    expect(html).toContain("data-page-actions-trigger");
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

  it("draws an integration of two spaces once, naming both and counting each connection once", () => {
    const { html, asked } = renderIn(true, <IntegrationsPage />, "/integrations", seed);
    expect(asked("packages")).toEqual([["packages", "integrations", "org_1", "across-spaces"]]);
    expect(html).toContain('href="/integrations/@acme/crm"');
    expect(html).not.toContain("enterSpace=");
    // The org-scoped connection reaches both spaces and counts once.
    expect(html).toMatch(
      /title="Studio">Studio<\/span><span[^>]*title="spc_b">\+1<\/span><\/span><span aria-hidden="true">·<\/span>.*?2 connexions/,
    );
    expect(html).toContain("data-page-actions-trigger");
  });

  it("counts integrations, not the spaces they are active in", () => {
    const { html } = renderIn(true, <IntegrationsPage />, "/integrations", seed);
    expect(html).toContain("1 intégration");
    expect(html).not.toContain("2 intégrations");
  });

  it("says the list is empty across the spaces, offering the creation", () => {
    const empty = (overview: boolean) =>
      renderIn(overview, <IntegrationsPage />, "/integrations", (qc) =>
        qc.setQueryData(
          overview
            ? ["packages", "integrations", "org_1", "across-spaces"]
            : ["packages", "integrations", "org_1", "spc_a"],
          [],
        ),
      ).html;
    expect(empty(true)).toContain("Aucune intégration active dans vos espaces.");
    expect(empty(true)).toContain("Nouvelle intégration");
    expect(empty(false)).toContain("Aucune intégration active dans cet espace.");
    expect(empty(false)).toContain("Nouvelle intégration");
  });
});

describe("the files gallery in the mode", () => {
  // Each file names only its run in the « … » menu: a row has a menu exactly when its run link shows.
  const file = (name: string, spaceId: string) =>
    fileFixture({
      name,
      spaceId,
      runId: `run_${name}`,
      capabilities: {
        visible: true,
        metadata: true,
        download: false,
        preview: false,
        keep: false,
        delete: false,
      },
    });
  const seed = (queryClient: QueryClient) =>
    queryClient.setQueryData(
      [
        "get",
        "/api/orgs/{orgId}/files",
        "paged",
        {
          params: {
            path: { orgId: "org_1" },
            query: { purpose: undefined, q: undefined, limit: 25 },
          },
        },
      ],
      {
        pages: [
          { object: "list", hasMore: false, data: [file("here", "spc_a"), file("there", "spc_b")] },
        ],
        pageParams: [undefined],
      },
    );

  it("offers each row the keep and delete its own space grants", () => {
    const writable = (name: string, spaceId: string, granted: boolean) =>
      fileFixture({
        name,
        spaceId,
        expiresAt: "2026-12-01T00:00:00.000Z",
        capabilities: {
          visible: true,
          metadata: true,
          download: false,
          preview: false,
          keep: granted,
          delete: granted,
        },
      });
    const { html } = renderIn(true, <FilesPage />, "/files", (queryClient) =>
      queryClient.setQueryData(
        [
          "get",
          "/api/orgs/{orgId}/files",
          "paged",
          {
            params: {
              path: { orgId: "org_1" },
              query: { purpose: undefined, q: undefined, limit: 25 },
            },
          },
        ],
        {
          pages: [
            {
              object: "list",
              hasMore: false,
              data: [writable("here", "spc_a", false), writable("there", "spc_b", true)],
            },
          ],
          pageParams: [undefined],
        },
      ),
    );
    // Keep and delete are the rows' only deeds: a row has a menu exactly when its space grants them.
    expect(html).toContain("Plus d'actions pour there");
    expect(html).not.toContain("Plus d'actions pour here");
  });

  it("links a file to its run where the file's space reads runs, not the working space", () => {
    const { html } = renderIn(true, <FilesPage />, "/files", seed);
    expect(html).toContain("Plus d'actions pour there");
    // The working space reads no run.
    expect(html).not.toContain("Plus d'actions pour here");
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
      ],
      {
        pages: [
          {
            object: "list",
            hasMore: false,
            data: [
              makeRun({ id: "run_b", spaceId: "spc_b", packageId: "@acme/reporter" }),
              makeRun({ id: "run_a", spaceId: "spc_a", packageId: "@acme/reporter" }),
            ],
            total: 2,
          },
        ],
        pageParams: [undefined],
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

  it("draws an agent of two spaces once, and each run linking into its space", () => {
    const { html } = renderIn(true, <DashboardPage />, "/", seed);
    expect(html.match(/href="\/agents\/@acme\/reporter(\?[^"]*)?"/g)).toEqual([
      'href="/agents/@acme/reporter"',
    ]);
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_b?enterSpace=spc_b"');
    expect(html).toContain('href="/agents/@acme/reporter/runs/run_a"');
  });

  it("offers the assistant, and an agent's run on its card where a space grants it", () => {
    const { html } = renderIn(true, <DashboardPage />, "/", seed);
    expect(html).toContain("data-page-actions-trigger");
    // One card for the agent of two spaces; only spc_a grants `agents:run`.
    expect(html.match(/aria-label="Lancer"/g)).toHaveLength(1);
    // Out of the mode, a working space that reads runs offers the assistant and the agent's run.
    const here = renderIn(
      false,
      <DashboardPage />,
      "/",
      (queryClient) => {
        queryClient.setQueryData(["agents", "org_1", "spc_a"], [agent("spc_a")]);
        queryClient.setQueryData(["schedules", "org_1", "spc_a"], []);
        queryClient.setQueryData(
          [
            "paginated-runs",
            "org_1",
            "spc_a",
            "/runs",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            15,
          ],
          {
            pages: [{ object: "list", hasMore: false, data: [], total: 0 }],
            pageParams: [undefined],
          },
        );
      },
      [space("spc_a", [...SPACES[0]!.permissions, "runs:read"]), SPACES[1]!],
    ).html;
    expect(here).toContain("data-page-actions-trigger");
    expect(here).toContain('aria-label="Lancer"');
  });

  it("counts an agent once, though it runs in two spaces", () => {
    const { html } = renderIn(true, <DashboardPage />, "/", seed);
    expect(html).toMatch(/Agents disponibles<\/span><div><p[^>]*>1<\/p>/);
  });

  it("offers the assistant while the space listing has not answered, as once it has", () => {
    // No org, so no listing: whether the mode is on is not known yet, and nothing waits on it.
    expect(render(<DashboardPage />)).toContain("data-page-actions-trigger");
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
