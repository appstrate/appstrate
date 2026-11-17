// SPDX-License-Identifier: Apache-2.0

/**
 * The agent page in « Tous les espaces »: its header names the spaces the agent runs in and no
 * working space, so nothing on it may act in, or be judged by, the hidden working space. A deed
 * that needs a space asks it — one click naming it when one space fits, the menu of them when
 * several do, nothing when none does — and the run is judged in the space chosen at launch.
 * With a space selected, every deed acts there as before.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AgentDetail } from "@appstrate/shared-types";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { render } = await import("../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { $api } = await import("../../api/client.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");
const { packageDetailQueryOptions } = await import("../../hooks/use-packages.ts");
const { usePackageActions } = await import("../package-detail/use-package-actions.tsx");
const { useBundleDeed, useClearRunsDeed } = await import("../package-detail/use-agent-deeds.ts");
const { AgentRunButton } = await import("../package-detail/agent-run-button.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

const PACKAGE_ID = "@acme/reporter";
const NAMES: Record<string, string> = { spc_a: "Atelier", spc_b: "Studio", spc_c: "Coffre" };

const space = (id: string, permissions: string[]) => ({
  id,
  object: "space",
  orgId: "org_1",
  access: "member",
  permissions,
  personal: false,
  isDefault: id === "spc_a",
  name: NAMES[id] ?? id,
  icon: null,
  color: null,
  role: null,
});

/** The working space (Atelier, hidden in the mode) and two others. */
const SPACES = [
  space("spc_a", ["agents:read", "agents:run"]),
  space("spc_b", ["agents:read", "agents:write", "agents:run", "runs:delete", "runs:read-all"]),
  space("spc_c", ["agents:read", "agents:write", "agents:run", "runs:delete", "runs:read-all"]),
];

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: PACKAGE_ID,
    icon: null,
    color: null,
    source: "local",
    display_name: "Rapporteur",
    dependencies: { skills: [], integrations: [] },
    input: { schema: { type: "object", properties: {} }, values: {}, locked_fields: [] },
    running_runs: 0,
    last_run: null,
    prompt: "Rapporte.",
    manifest: { name: PACKAGE_ID },
    scope: "@acme",
    version: "1.0.0",
    version_count: 1,
    definition: "published",
    home_space_id: "spc_b",
    home_writable: false,
    home_deletable: false,
    home_shareable: false,
    effective_timeout_seconds: 300,
    // Switched off in the hidden working space, running in Studio and Coffre.
    active: false,
    space_ids: ["spc_b", "spc_c"],
    ...over,
  };
}

/** The organization library's row: off in Atelier, on (shared) in Studio, not placed in Coffre. */
const LIBRARY = {
  object: "library",
  spaces: SPACES.map(({ id, name }) => ({ id, name })),
  packages: {
    agent: [
      {
        id: PACKAGE_ID,
        placements: [
          {
            space_id: "spc_a",
            via: "home",
            state: "inactive",
            shared_by: null,
            chat_enforced: false,
          },
          {
            space_id: "spc_b",
            via: "shared",
            state: "active",
            shared_by: null,
            chat_enforced: false,
          },
        ],
        activation: [
          { spaceId: "spc_a", activate: "allowed", deactivate: "allowed" },
          { spaceId: "spc_b", activate: "allowed", deactivate: "allowed" },
          { spaceId: "spc_c", activate: "allowed", deactivate: "forbidden" },
        ],
      },
    ],
    skill: [],
    integration: [],
  },
};

let stubs: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const stub of stubs) stub.mockRestore();
  stubs = [];
});

function renderIn(
  overview: boolean,
  node: React.ReactElement,
  seed: (qc: QueryClient) => void = () => {},
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
  const qc = new QueryClient();
  qc.setQueryData(
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
  qc.setQueryData(["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }], {
    object: "list",
    hasMore: false,
    data: SPACES,
  });
  qc.setQueryData(
    $api.queryOptions("get", "/api/library", { params: { header: { "X-Org-Id": "org_1" } } })
      .queryKey,
    LIBRARY,
  );
  seed(qc);
  return render(node, { queryClient: qc });
}

const NONE = { offered: false };

/** The menu's visible entries: `id|label|spaces of its sub-menu`. */
function MenuProbe({
  isActiveHere,
  source = "local",
}: {
  isActiveHere?: boolean;
  source?: AgentDetail["source"];
}) {
  const { sections } = usePackageActions({
    packageId: PACKAGE_ID,
    type: "agent",
    detail: detail({ source }),
    isHistoricalVersion: false,
    isActiveHere,
    agent: {
      runWithOptions: NONE,
      addSchedule: NONE,
      bundle: NONE,
      clearRuns: NONE,
      clearMemories: NONE,
      onDeleteAgent: () => {},
    },
  });
  return (
    <ul>
      {sections
        .flatMap((section) => section.entries)
        .map((entry) => (
          <li key={entry.id}>
            {`${entry.id}|${entry.label}|${entry.inSpaces?.spaces.map((s) => s.id).join(",") ?? ""}`}
          </li>
        ))}
    </ul>
  );
}

const entry = (html: string, id: string) =>
  html.match(new RegExp(`<li>${id}\\|([^<]*)</li>`))?.[1] ?? null;

describe("the Actions menu in the mode", () => {
  it("asks the space of each placement deed, from the organization library", () => {
    const html = renderIn(true, <MenuProbe isActiveHere={false} />);
    // Off in Atelier, not placed in Coffre: both may be switched on, the reader chooses.
    expect(entry(html, "activate")).toBe("Activer dans…|spc_a,spc_c");
    // Running in Studio alone where the reader may switch it off: one click, naming it.
    expect(entry(html, "deactivate")).toBe("Désactiver dans Studio|");
    // Shared to Studio: taken out of Studio.
    expect(entry(html, "remove-here")).toBe("Retirer de Studio|");
  });

  it("asks the space a copy goes to, among those the reader writes agents in", () => {
    // A system agent is duplicated, never edited in place.
    expect(entry(renderIn(true, <MenuProbe source="system" />), "fork")).toBe(
      "Dupliquer|spc_b,spc_c",
    );
  });

  it("offers none of them where no space allows it", () => {
    const html = renderIn(true, <MenuProbe />, (qc) =>
      qc.setQueryData(
        $api.queryOptions("get", "/api/library", { params: { header: { "X-Org-Id": "org_1" } } })
          .queryKey,
        { ...LIBRARY, packages: { ...LIBRARY.packages, agent: [] } },
      ),
    );
    expect(entry(html, "activate")).toBeNull();
    expect(entry(html, "deactivate")).toBeNull();
    expect(entry(html, "remove-here")).toBeNull();
  });

  it("CONTROL: acts in the working space out of the mode", () => {
    // The space library is the working space's verdict: unseeded, it offers no switch, and the
    // menu never reads the organization's.
    const html = renderIn(false, <MenuProbe isActiveHere={false} />);
    expect(entry(html, "activate")).toBeNull();
    expect(entry(html, "deactivate")).toBeNull();
    // Atelier does not grant `agents:write`: no fork.
    expect(entry(renderIn(false, <MenuProbe source="system" />), "fork")).toBeNull();
  });
});

/** One deed of the agent: `offered|label|spaces of its sub-menu`. */
function DeedProbe({ of }: { of: "clearRuns" | "bundle" }) {
  const agent = detail();
  const deeds = {
    clearRuns: useClearRunsDeed(PACKAGE_ID, agent, () => {}),
    bundle: useBundleDeed(agent, () => {}),
  };
  const deed = deeds[of];
  return (
    <p>{`${deed.offered}|${deed.label ?? ""}|${deed.inSpaces?.spaces.map((s) => s.id).join(",") ?? ""}`}</p>
  );
}

const runsKey = (spaceId: string) =>
  $api.queryOptions("get", "/api/agents/{scope}/{name}/runs", {
    params: {
      path: { scope: "@acme", name: "reporter" },
      query: { limit: 1 },
      header: { "X-Org-Id": "org_1", "X-Space-Id": spaceId },
    },
  }).queryKey;

describe("« Supprimer les runs » in the mode", () => {
  it("is offered in the spaces where the agent has runs the reader may delete, naming one", () => {
    const html = renderIn(true, <DeedProbe of="clearRuns" />, (qc) => {
      qc.setQueryData(runsKey("spc_b"), {
        object: "list",
        data: [{ id: "run_1" }],
        hasMore: false,
      });
      qc.setQueryData(runsKey("spc_c"), { object: "list", data: [], hasMore: false });
    });
    expect(html).toContain("true|Supprimer les runs dans Studio|");
  });

  it("is absent when no such space holds a run, whatever the hidden space says", () => {
    const html = renderIn(true, <DeedProbe of="clearRuns" />, (qc) => {
      qc.setQueryData(runsKey("spc_b"), { object: "list", data: [], hasMore: false });
      qc.setQueryData(runsKey("spc_c"), { object: "list", data: [], hasMore: false });
    });
    expect(html).toContain("<p>false||</p>");
  });
});

describe("« Télécharger le bundle »", () => {
  it("is offered in the mode where the agent runs in a space the reader reads, though off in the hidden one", () => {
    expect(renderIn(true, <DeedProbe of="bundle" />)).toContain("<p>true||</p>");
  });

  it("CONTROL: follows the working space out of the mode", () => {
    expect(renderIn(false, <DeedProbe of="bundle" />)).toContain("<p>false||</p>");
  });
});

describe("« Lancer » in the mode", () => {
  const seedDetail = (qc: QueryClient) =>
    qc.setQueryData(
      packageDetailQueryOptions("agent", { orgId: "org_1", spaceId: "spc_a" }, PACKAGE_ID).queryKey,
      detail(),
    );
  const button = (html: string) => html.match(/<button[^>]*>/)?.[0] ?? "";

  it("is not held back by the hidden working space, where the agent is off", () => {
    const html = renderIn(
      true,
      <AgentRunButton packageId={PACKAGE_ID} versionLabel={undefined} />,
      seedDetail,
    );
    expect(button(html)).not.toContain('disabled=""');
    expect(html).not.toContain(i18n.t("detail.titleNotActive", { ns: "agents" }));
  });

  it("CONTROL: is held back out of the mode, the working space being named", () => {
    const html = renderIn(
      false,
      <AgentRunButton packageId={PACKAGE_ID} versionLabel={undefined} />,
      seedDetail,
    );
    expect(button(html)).toContain('disabled=""');
  });
});
