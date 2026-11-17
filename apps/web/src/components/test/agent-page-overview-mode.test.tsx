// SPDX-License-Identifier: Apache-2.0

/**
 * The agent page in « Tous les espaces »: its header names the spaces the agent runs in and no
 * working space, so nothing on it may act in, or be judged by, the hidden working space. A deed
 * that needs a space asks it — one click naming it when one space fits, the menu of them when
 * several do, nothing when none does — and the run is judged in the space chosen at launch.
 * With a space selected, every deed acts there as before.
 */

import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AgentDetail } from "@appstrate/shared-types";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
});
await import("sonner");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { documentElement: { classList: { add: () => {}, remove: () => {} } } },
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "document");
});

const { render } = await import("../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { $api } = await import("../../api/client.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");
const { packageDetailQueryOptions } = await import("../../hooks/use-packages.ts");
const { ACROSS_SPACES, paginatedRunsKeys, persistenceKeys } =
  await import("../../lib/query-keys.ts");
const { usePackageActions } = await import("../package-detail/use-package-actions.tsx");
const { useAgentActions } = await import("../package-detail/use-agent-actions.tsx");
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

const DEEDS = ["agents:read", "agents:write", "agents:run", "runs:delete", "runs:read-all"];

/** The working space (Atelier, hidden in the mode) and two others. */
const SPACES = [
  space("spc_a", ["agents:read", "agents:run"]),
  space("spc_b", [...DEEDS, "schedules:write", "persistence:read", "persistence:delete"]),
  space("spc_c", [...DEEDS, "persistence:read", "persistence:delete"]),
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
    read_space_ids: ["spc_b", "spc_c"],
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

/** The menu's visible entries: `id|label|spaces of its sub-menu`, `data-disabled` when greyed. */
function MenuProbe({
  isActiveHere,
  source = "local",
  deletable = false,
}: {
  isActiveHere?: boolean;
  source?: AgentDetail["source"];
  deletable?: boolean;
}) {
  const { sections } = usePackageActions({
    packageId: PACKAGE_ID,
    type: "agent",
    detail: detail({ source, home_deletable: deletable }),
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
          <li key={entry.id} data-disabled={entry.disabled ? "" : undefined}>
            {`${entry.id}|${entry.label}|${entry.inSpaces?.spaces.map((s) => s.id).join(",") ?? ""}`}
          </li>
        ))}
    </ul>
  );
}

const entry = (html: string, id: string) =>
  html.match(new RegExp(`<li[^>]*>${id}\\|([^<]*)</li>`))?.[1] ?? null;
const disabledEntry = (html: string, id: string) =>
  new RegExp(`<li data-disabled="">${id}\\|`).test(html);

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
      "Dupliquer dans…|spc_b,spc_c",
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

type AgentDeed = "runWithOptions" | "addSchedule" | "bundle" | "clearRuns" | "clearMemories";

/** One deed of the agent menu: `offered|label|spaces of its sub-menu|disabled`. */
function DeedProbe({ of }: { of: AgentDeed }) {
  const { dropdown } = useAgentActions({
    packageId: PACKAGE_ID,
    isHistoricalVersion: false,
    downloadVersion: "1.0.0",
    downloadPackage: () => {},
    downloadBundle: () => {},
    onCreateVersion: () => {},
  });
  const deed = dropdown?.agent?.[of];
  if (!deed) return <p>none</p>;
  return (
    <p>{`${deed.offered}|${deed.label ?? ""}|${deed.inSpaces?.spaces.map((s) => s.id).join(",") ?? ""}|${deed.disabled ? "disabled" : ""}`}</p>
  );
}

const detailKey = (spaceId: string) =>
  packageDetailQueryOptions("agent", { orgId: "org_1", spaceId }, PACKAGE_ID).queryKey;

/** The agent's runs across spaces: its latest one and those in flight, as the overview reads them. */
function seedRuns(
  qc: QueryClient,
  {
    latest,
    inFlight,
    hasMore = false,
  }: { latest: string[]; inFlight: string[]; hasMore?: boolean },
) {
  const page = (spaceIds: string[]) => ({
    pages: [
      {
        object: "list",
        data: spaceIds.map((spaceId, i) => ({ id: `run_${i}`, status: "running", spaceId })),
        total: spaceIds.length,
        hasMore,
      },
    ],
    pageParams: [undefined],
  });
  const key = (status: string | undefined, limit: number) =>
    paginatedRunsKeys.list(
      "org_1",
      ACROSS_SPACES,
      `/agents/${PACKAGE_ID}/runs`,
      undefined,
      undefined,
      status,
      undefined,
      undefined,
      limit,
    );
  qc.setQueryData(key(undefined, 1), page(latest));
  qc.setQueryData(key("pending,running", 25), page(inFlight));
}

const seedMemories = (qc: QueryClient, spaceIds: string[]) =>
  qc.setQueryData(
    persistenceKeys.list("org_1", ACROSS_SPACES, "agent-memories", PACKAGE_ID, { kind: "memory" }),
    spaceIds.map((spaceId, i) => ({
      id: i,
      content: "note",
      runId: null,
      actor_type: "shared",
      actor_id: null,
      createdAt: null,
      spaceId,
    })),
  );

const probe = (overview: boolean, of: AgentDeed, seed: (qc: QueryClient) => void = () => {}) =>
  renderIn(overview, <DeedProbe of={of} />, (qc) => {
    qc.setQueryData(detailKey("spc_a"), detail());
    seed(qc);
  });

describe("the agent's deeds in the mode", () => {
  it("ask the space among several, the menu labelled « … dans… »", () => {
    expect(probe(true, "runWithOptions")).toContain(
      "<p>true|Lancer avec options dans…|spc_b,spc_c|</p>",
    );
  });

  it("name the one space they act in", () => {
    // Studio alone grants writing schedules.
    expect(probe(true, "addSchedule")).toContain("<p>true|Planifier dans Studio||</p>");
  });

  it("CONTROL: act in the working space under their own label out of the mode", () => {
    expect(probe(false, "runWithOptions")).toContain("<p>true|||</p>");
    expect(probe(false, "addSchedule")).toContain("<p>false|||</p>");
  });

  it("offer « Supprimer les runs » where runs may be deleted and none is in flight", () => {
    // Runs in Studio and Coffre may be deleted; Coffre has one in flight.
    const html = probe(true, "clearRuns", (qc) =>
      seedRuns(qc, { latest: ["spc_c"], inFlight: ["spc_c"] }),
    );
    expect(html).toContain("<p>true|Supprimer les runs dans Studio||</p>");
  });

  it("can clear a switched-off placement when another space fills the first page of running runs", () => {
    const html = probe(true, "clearRuns", (qc) => {
      qc.setQueryData(detailKey("spc_a"), detail({ space_ids: ["spc_c"] }));
      seedRuns(qc, { latest: ["spc_b"], inFlight: Array(25).fill("spc_c"), hasMore: true });
    });
    expect(html).toContain("<p>true|Supprimer les runs dans Studio||</p>");
  });

  it("hold « Supprimer les runs » back while every such space has a run in flight", () => {
    const html = probe(true, "clearRuns", (qc) =>
      seedRuns(qc, { latest: ["spc_b"], inFlight: ["spc_b", "spc_c"] }),
    );
    expect(html).toContain("|disabled</p>");
  });

  it("offer no « Supprimer les runs » for an agent that never ran, whatever the hidden space says", () => {
    expect(probe(true, "clearRuns", (qc) => seedRuns(qc, { latest: [], inFlight: [] }))).toContain(
      "<p>false|||</p>",
    );
  });

  it("offer « Supprimer les mémoires » in the spaces that hold memory and grant deleting it", () => {
    expect(probe(true, "clearMemories", (qc) => seedMemories(qc, ["spc_b", "spc_b"]))).toContain(
      "<p>true|Supprimer les mémoires dans Studio||</p>",
    );
    expect(probe(true, "clearMemories", (qc) => seedMemories(qc, ["spc_b", "spc_c"]))).toContain(
      "<p>true|Supprimer les mémoires dans…|spc_b,spc_c|</p>",
    );
    expect(probe(true, "clearMemories", (qc) => seedMemories(qc, []))).toContain("<p>false|||</p>");
  });

  it("offer the bundle from a space the agent runs in, though off in the hidden one, naming none", () => {
    expect(probe(true, "bundle")).toContain("<p>true|||</p>");
  });

  it("CONTROL: offer the bundle out of the mode only where the agent is active", () => {
    expect(probe(false, "bundle")).toContain("<p>false|||</p>");
  });
});

describe("« Supprimer » in the mode", () => {
  const runsInFlight = (inFlight: string[]) => (qc: QueryClient) =>
    seedRuns(qc, { latest: inFlight, inFlight });

  it("waits for the agent's runs in flight in every space", () => {
    const html = renderIn(true, <MenuProbe deletable />, runsInFlight(["spc_c"]));
    expect(disabledEntry(html, "delete")).toBe(true);
  });

  it("is open once no run is in flight anywhere, whatever the hidden space counts", () => {
    const html = renderIn(true, <MenuProbe deletable />, runsInFlight([]));
    expect(entry(html, "delete")).not.toBeNull();
    expect(disabledEntry(html, "delete")).toBe(false);
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

  it("is held back, saying so, when the agent is active in none of the reader's spaces", () => {
    const html = renderIn(
      true,
      <AgentRunButton packageId={PACKAGE_ID} versionLabel={undefined} />,
      (qc) => qc.setQueryData(detailKey("spc_a"), detail({ space_ids: [] })),
    );
    expect(button(html)).toContain('disabled=""');
    expect(html).toContain(i18n.t("detail.titleNotActiveAcross", { ns: "agents" }));
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
