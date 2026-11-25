// SPDX-License-Identifier: Apache-2.0

/**
 * « Tous les espaces » over the working space: the switcher names it, the list pages and the
 * dashboard ask the org routes (which list every space the reader reaches) and nothing of the
 * working space's lists, one row per placement naming its space and linking into it, and the gate
 * opens a list another space admits. Nothing is hidden by the mode: a row acts in its own space,
 * by that space's grants, and an action naming no space is offered where some space grants it.
 * Out of the mode, nothing changes.
 */

import { describe, expect, it } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { SidebarProvider } from "@appstrate/ui/components/sidebar";
import { reporter } from "../../test/agent-detail.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { paginatedRunsKeys } from "../../lib/query-keys.ts";
import { STUDIO_PERMISSION } from "../../lib/route-access.ts";

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
const { memberSpaceClient, renderInSpace } = await import("../../test/space-context.ts");
const { DashboardPage } = await import("../dashboard.tsx");
const { PackageIndexPage } = await import("../package-index.tsx");
const { IntegrationsPage } = await import("../integrations-page.tsx");
const { FilesPage } = await import("../files.tsx");
const { fileFixture } = await import("../../test/render.tsx");
const { makeRun } = await import("../../test/run-fixture.ts");
const { WorkingSpaceName } = await import("../../components/space-name.tsx");
const { RunAgentButton } = await import("../../components/run-agent-button.tsx");
const { useRuns } = await import("../../hooks/use-paginated-runs.ts");

await i18nReady;
await i18n.changeLanguage("fr");

const space = (id: string, permissions: string[]) => ({
  id,
  object: "space",
  access: "member",
  permissions: [STUDIO_PERMISSION, ...permissions],
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

/** The agent, active in `space_ids`: the org route's one row naming both spaces. */
const agent = (space_ids: string[]) => ({
  id: "@acme/reporter",
  space_ids,
  home_space_id: "spc_a",
  source: "local" as const,
  version: "1.0.0",
  description: "Rapporte",
  scope: "@acme",
  icon: null,
  color: null,
  display_name: "Rapporteur",
  keywords: [],
  dependencies: { integrations: {} },
  integrations: [],
  running_runs: 0,
  unread_count: 0,
  published: true,
  type: "agent" as const,
  forked_from: null,
});
const AGENTS = [agent(["spc_a", "spc_b"])];

const packageRow = (space_ids: string[], extra: Record<string, unknown> = {}) => ({
  id: "@acme/crm",
  space_ids,
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
  home_space_id: "spc_a",
  home_writable: true,
  home_deletable: true,
  home_shareable: true,
  ...extra,
});

function renderIn(
  overview: boolean,
  node: React.ReactElement,
  url = "/",
  seed: (queryClient: QueryClient) => void = () => {},
  spaces: readonly ReturnType<typeof space>[] = SPACES,
) {
  const queryClient = memberSpaceClient(spaces);
  seed(queryClient);
  const html = renderInSpace(<SidebarProvider>{node}</SidebarProvider>, {
    overview,
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
  it("names the organization and the space, or the mode, in its accessible name", () => {
    expect(renderIn(true, <OrgSwitcher />).html).toContain(
      "aria-label=\"Changer d'organisation ou d'espace (actuel : Acme, Tous les espaces)\"",
    );
    expect(renderIn(false, <OrgSwitcher />).html).toContain(
      "aria-label=\"Changer d'organisation ou d'espace (actuel : Acme, Studio)\"",
    );
  });

  it("names the mode where it names the working space", () => {
    expect(renderIn(true, <OrgSwitcher />).html).toContain('title="Tous les espaces"');
    expect(renderIn(false, <OrgSwitcher />).html).toContain('title="Studio"');
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

  it("chooses the space in the creation's own menu between several, acts at once with one", () => {
    const creation = (spaces: readonly ReturnType<typeof space>[]) => {
      const { html } = renderIn(
        true,
        <SchedulesListPage />,
        "/schedules",
        (qc) => qc.setQueryData(["schedules", "org_1", "across-spaces"], []),
        spaces,
      );
      // The empty state's button: its own trigger, a menu of the spaces or a plain button.
      const at = html.indexOf("Nouvelle planification");
      return html.slice(html.lastIndexOf("<button", at), at);
    };
    // Only spc_a writes schedules: the button creates there, no menu.
    expect(creation(SPACES)).not.toContain('aria-haspopup="menu"');
    const writer = space("spc_c", ["schedules:read", "schedules:write"]);
    expect(creation([...SPACES, writer])).toContain('aria-haspopup="menu"');
  });
});

describe("the space a screen acts in", () => {
  it("is named in the mode, the working space's own name; nothing out of it", () => {
    expect(renderIn(true, <WorkingSpaceName />).html).toContain('title="Studio">Studio</span>');
    expect(renderIn(false, <WorkingSpaceName />).html).not.toContain("Studio");
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
    // The « Espace » column names the home and counts the other, named in the badge's label.
    expect(html).toContain(">Espace<");
    expect(html).toMatch(/title="Studio">Studio<\/span>.*aria-label="Actif aussi dans spc_b"/);
    expect(html).toContain("1 élément");
  });

  it("offers a row's run where one of its spaces grants it, whatever the working space grants", () => {
    const run = (spaces: typeof SPACES) =>
      /aria-label="Lancer dans [^"]+"/.test(
        renderIn(true, <PackageIndexPage type="agent" />, "/agents", seed, spaces).html,
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

  it("runs a row in the working space when it is one of its spaces, else lets the reader choose", () => {
    const runner = (id: string) => space(id, ["agents:read", "agents:run"]);
    const runButton = (spaceIds: string[]) => {
      const { html } = renderIn(
        true,
        <PackageIndexPage type="agent" />,
        "/agents",
        (qc) => qc.setQueryData(["agents", "org_1", "across-spaces"], [agent(spaceIds)]),
        [SPACES[0]!, runner("spc_b"), runner("spc_c")],
      );
      const at = html.indexOf('aria-label="Lancer dans');
      return html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at));
    };
    // In the working space, named: one click.
    const here = runButton(["spc_a", "spc_b"]);
    expect(here).toContain('aria-label="Lancer dans Studio"');
    expect(here).not.toContain('aria-haspopup="menu"');
    // Elsewhere, between two spaces: the menu, asking.
    const between = runButton(["spc_b", "spc_c"]);
    expect(between).toContain('aria-label="Lancer dans…"');
    expect(between).toContain('aria-haspopup="menu"');
  });

  it("offers no write while the space listing has not answered: it appears once, never flips", () => {
    const { html } = renderIn(true, <PackageIndexPage type="agent" />, "/agents", (qc) => {
      qc.removeQueries({ queryKey: ["get", "/api/spaces"] });
      qc.setQueryData(["agents", "org_1", "spc_a"], [agent(["spc_a"])]);
    });
    expect(html).not.toContain("data-page-actions-trigger");
    expect(html).not.toContain('aria-label="Lancer');
  });

  it("offers the creation, import and catalogue a space grants", () => {
    const { html } = renderIn(true, <PackageIndexPage type="agent" />, "/agents", seed);
    expect(html).toContain("data-page-actions-trigger");
  });

  it("names no space out of the mode", () => {
    const { html } = renderIn(false, <PackageIndexPage type="agent" />, "/agents");
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
        [packageRow(["spc_a", "spc_b"])],
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
        packageRow(["spc_a", "spc_b"], {
          source_kind: "remote",
          server: null,
          authenticated: true,
        }),
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
      /title="Studio">Studio<\/span>.*aria-label="Actif aussi dans spc_b".*?<span aria-hidden="true">·<\/span>.*?2 connexions/,
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
      paginatedRunsKeys.list(
        "org_1",
        "across-spaces",
        "/runs",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        15,
      ),
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

  it("requests the recent runs and filtered active count across the organization", () => {
    const { asked } = renderIn(true, <DashboardPage />, "/", seed);
    expect(asked("agents")).toEqual([["agents", "org_1", "across-spaces"]]);
    expect(asked("schedules")).toEqual([["schedules", "org_1", "across-spaces"]]);
    expect(asked("paginated-runs")).toMatchObject([
      [
        "paginated-runs",
        "org_1",
        "across-spaces",
        { endpoint: "/runs", status: undefined, limit: 15 },
      ],
      [
        "paginated-runs",
        "org_1",
        "across-spaces",
        { endpoint: "/runs", status: "running", limit: 1 },
      ],
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
    // One card for the agent of two spaces; only spc_a grants `agents:run`: named.
    expect(html.match(/aria-label="Lancer dans Studio"/g)).toHaveLength(1);
    // Out of the mode, a working space that reads runs offers the assistant and the agent's run.
    const here = renderIn(
      false,
      <DashboardPage />,
      "/",
      (queryClient) => {
        queryClient.setQueryData(["agents", "org_1", "spc_a"], [agent(["spc_a"])]);
        queryClient.setQueryData(["schedules", "org_1", "spc_a"], []);
        queryClient.setQueryData(
          paginatedRunsKeys.list(
            "org_1",
            "spc_a",
            "/runs",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            15,
          ),
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

describe("an agent's page", () => {
  const runner = (id: string) => space(id, ["agents:read", "agents:run", "runs:read"]);
  const reader = (id: string) => space(id, ["agents:read", "runs:read"]);
  const detail = (space_ids: string[]) =>
    reporter({ active: true, home_space_id: "spc_a", space_ids, read_space_ids: space_ids });

  /** The page's « Lancer »: its opening tag, or `null` when it is absent. */
  const runButton = (overview: boolean, spaceIds: string[], spaces: ReturnType<typeof space>[]) => {
    const { html } = renderIn(
      overview,
      <RunAgentButton
        packageId="@acme/reporter"
        detail={detail(spaceIds)}
        spaceIds={spaceIds}
        preferWorkingSpace={false}
        showLabel
      />,
      "/agents/@acme/reporter",
      () => {},
      spaces,
    );
    const at = html.search(/>Lancer( dans[^<]*)?</);
    return at < 0
      ? null
      : html.slice(
          html.lastIndexOf("<button", at),
          html.indexOf(">", html.lastIndexOf("<button", at)),
        );
  };

  it("asks which space between the agent's spaces that run it, the working one included", () => {
    const html = runButton(true, ["spc_a", "spc_b"], [runner("spc_a"), runner("spc_b")]);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('title="Lancer dans…"');
  });

  it("asks nothing with one space running it, and runs in the working space out of the mode", () => {
    const one = runButton(true, ["spc_a", "spc_b"], [reader("spc_a"), runner("spc_b")]);
    expect(one).toContain('title="Lancer dans spc_b"');
    expect(one).not.toContain('aria-haspopup="menu"');
    const here = runButton(false, ["spc_a", "spc_b"], [runner("spc_a"), runner("spc_b")]);
    expect(here).toContain('title="Lancer"');
    expect(here).not.toContain('aria-haspopup="menu"');
  });

  it("offers no run where none of its spaces runs it", () => {
    expect(runButton(true, ["spc_a", "spc_b"], [reader("spc_a"), reader("spc_b")])).toBeNull();
  });

  it("lists the agent's runs of every space in the mode, its space's out of it", () => {
    function Probe() {
      useRuns({ packageId: "@acme/reporter", spanning: true });
      useRuns({ packageId: "@acme/reporter" });
      return null;
    }
    const { asked } = renderIn(true, <Probe />, "/agents/@acme/reporter", () => {}, [
      runner("spc_a"),
      runner("spc_b"),
    ]);
    expect(asked("paginated-runs")).toMatchObject([
      ["paginated-runs", "org_1", "across-spaces", { endpoint: "/agents/@acme/reporter/runs" }],
      ["paginated-runs", "org_1", "spc_a", { endpoint: "/agents/@acme/reporter/runs" }],
    ]);
  });
});
