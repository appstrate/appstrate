// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's schedules, memory and configuration in « Tous les espaces »: the lists and the
 * figures cover every space the reader reaches, each row naming its space; the configuration,
 * kept per space, names the one it shows. With a space selected, each is that space's, unnamed.
 */

import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type {
  AgentDetail,
  AgentMemoryItem,
  AgentPinnedSlotItem,
  EnrichedSchedule,
} from "@appstrate/shared-types";
import { installFakeStorage } from "../../../test/fake-storage.ts";

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

const { render } = await import("../../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../../i18n.ts");
const { orgStore } = await import("../../../stores/org-store.ts");
const { spaceStore } = await import("../../../stores/space-store.ts");
const { authStore } = await import("../../../stores/auth-store.ts");
const { overviewStore } = await import("../../../stores/overview-store.ts");
const { packageDetailQueryOptions } = await import("../../../hooks/use-packages.ts");
const { ACROSS_SPACES, persistenceKeys, scheduleKeys } = await import("../../../lib/query-keys.ts");
const { AgentSchedulesTab, AgentMemoryTab } = await import("../../package-detail/agent-tabs.tsx");
const { AgentOverviewTab } = await import("../agent-overview-tab.tsx");
const { AgentConfigurationView } = await import("../agent-configuration-view.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

const PACKAGE_ID = "@acme/reporter";
const NAMES: Record<string, string> = { spc_a: "Atelier", spc_b: "Studio", spc_c: "Coffre" };
const READS = ["agents:read", "schedules:read", "persistence:read", "runs:read-all"];

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

/** The working space (Atelier, hidden in the mode), and Studio and Coffre where the agent runs. */
const SPACES = [
  space("spc_a", READS),
  space("spc_b", [...READS, "agents:configure", "schedules:write", "persistence:delete"]),
  space("spc_c", READS),
];

const DETAIL: AgentDetail = {
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
  active: true,
  space_ids: ["spc_b", "spc_c"],
};

function schedule(id: string, spaceId: string, nextRunAt: string): EnrichedSchedule {
  return {
    id,
    packageId: PACKAGE_ID,
    userId: "u_1",
    endUserId: null,
    orgId: "org_1",
    spaceId,
    name: `Tournée ${NAMES[spaceId]}`,
    enabled: true,
    disabled_reason: null,
    cron_expression: "0 9 * * *",
    timezone: "UTC",
    input: null,
    generation_config_override: null,
    model_id_override: null,
    proxy_id_override: null,
    version_override: null,
    connection_overrides: null,
    dependency_overrides: null,
    last_run_at: null,
    next_run_at: nextRunAt,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    agent_name: "Rapporteur",
    actor_name: "Ursule",
    actor_type: "user",
    running_runs: 0,
    last_run_number: 0,
    unread_count: 0,
  };
}

const memory = (id: number, spaceId: string | undefined, content: string): AgentMemoryItem => ({
  id,
  content,
  runId: null,
  actor_type: "shared",
  actor_id: null,
  createdAt: "2026-11-10T00:00:00Z",
  ...(spaceId ? { spaceId } : {}),
});

const pinned = (id: number, spaceId: string | undefined): AgentPinnedSlotItem => ({
  id,
  key: `slot_${id}`,
  content: "épinglé",
  runId: null,
  actor_type: "shared",
  actor_id: null,
  createdAt: "2026-11-10T00:00:00Z",
  updatedAt: "2026-11-10T00:00:00Z",
  ...(spaceId ? { spaceId } : {}),
});

let stubs: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const stub of stubs) stub.mockRestore();
  stubs = [];
});

/** Renders `node` in Atelier, the mode on or off, with both the lists spanning spaces and Atelier's seeded. */
function renderIn(overview: boolean, node: React.ReactElement, initialEntries?: string[]) {
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
    packageDetailQueryOptions("agent", { orgId: "org_1", spaceId: "spc_a" }, PACKAGE_ID).queryKey,
    DETAIL,
  );
  // Across spaces: one schedule and one memory of each kind in Studio and Coffre.
  qc.setQueryData(scheduleKeys.listForAgent("org_1", ACROSS_SPACES, PACKAGE_ID), [
    schedule("sched_b", "spc_b", "2026-12-02T09:00:00Z"),
    schedule("sched_c", "spc_c", "2026-12-01T09:00:00Z"),
  ]);
  qc.setQueryData(
    persistenceKeys.list("org_1", ACROSS_SPACES, "agent-memories", PACKAGE_ID, { kind: "memory" }),
    [memory(1, "spc_b", "Note de Studio"), memory(2, "spc_c", "Note de Coffre")],
  );
  qc.setQueryData(
    persistenceKeys.list("org_1", ACROSS_SPACES, "agent-pinned", PACKAGE_ID, { kind: "pinned" }),
    [pinned(3, "spc_b"), pinned(4, "spc_c")],
  );
  // Atelier's own: one schedule, one memory.
  qc.setQueryData(scheduleKeys.listForAgent("org_1", "spc_a", PACKAGE_ID), [
    schedule("sched_a", "spc_a", "2026-12-03T09:00:00Z"),
  ]);
  qc.setQueryData(
    persistenceKeys.list("org_1", "spc_a", "agent-memories", PACKAGE_ID, { kind: "memory" }),
    [memory(5, undefined, "Note d'Atelier")],
  );
  qc.setQueryData(
    persistenceKeys.list("org_1", "spc_a", "agent-pinned", PACKAGE_ID, { kind: "pinned" }),
    [],
  );
  return render(node, { queryClient: qc, initialEntries });
}

const SPACE_HEADER = i18n.t("table.column.space", { ns: "common" });

/** The value shown under an overview figure's label. */
function figure(html: string, label: string): string | null {
  const at = html.indexOf(`>${label}<`);
  if (at < 0) return null;
  return html.slice(at).match(/<dd[^>]*>(?:<[^>]+>)*([^<]*)</)?.[1] ?? null;
}

describe("the schedules sub-list", () => {
  it("lists every space's schedules in the mode, each naming its space and opening there", () => {
    const html = renderIn(true, <AgentSchedulesTab packageId={PACKAGE_ID} />);
    expect(html).toContain("Tournée Studio");
    expect(html).toContain("Tournée Coffre");
    expect(html).not.toContain("Tournée Atelier");
    expect(html).toContain(SPACE_HEADER);
    expect(html).toContain("enterSpace=spc_b");
    expect(html).toContain("enterSpace=spc_c");
  });

  it("CONTROL: lists the working space's schedules out of the mode, no space named", () => {
    const html = renderIn(false, <AgentSchedulesTab packageId={PACKAGE_ID} />);
    expect(html).toContain("Tournée Atelier");
    expect(html).not.toContain("Tournée Studio");
    expect(html).not.toContain(SPACE_HEADER);
    expect(html).not.toContain("enterSpace=");
  });
});

describe("the memory tab", () => {
  it("lists every space's memory in the mode, each row naming its space", () => {
    const html = renderIn(true, <AgentMemoryTab packageId={PACKAGE_ID} />);
    expect(html).toContain("Note de Studio");
    expect(html).toContain("Note de Coffre");
    expect(html).not.toContain("Note d'Atelier");
    expect(html).toContain(SPACE_HEADER);
    expect(html).toContain(">Studio<");
    expect(html).toContain(">Coffre<");
  });

  it("CONTROL: lists the working space's memory out of the mode, no space named", () => {
    const html = renderIn(false, <AgentMemoryTab packageId={PACKAGE_ID} />);
    expect(html).toContain("Note d'Atelier");
    expect(html).not.toContain("Note de Studio");
    expect(html).not.toContain(SPACE_HEADER);
  });
});

describe("the overview's figures", () => {
  const t = (key: string) => i18n.t(key, { ns: "agents" });

  it("count the schedules and the memory of every space in the mode", () => {
    const html = renderIn(
      true,
      <AgentOverviewTab packageId={PACKAGE_ID} detail={DETAIL} isHistorical={false} />,
    );
    expect(figure(html, t("detail.overview.activeSchedules"))).toBe("2");
    expect(figure(html, t("detail.overview.archivedItems"))).toBe("2");
    expect(figure(html, t("detail.overview.pinnedItems"))).toBe("2");
    // The soonest fire among them: Coffre's, on 1 December.
    expect(figure(html, t("schedule.paramNextRun"))).toContain("1");
  });

  it("CONTROL: count the working space's out of the mode", () => {
    const html = renderIn(
      false,
      <AgentOverviewTab packageId={PACKAGE_ID} detail={DETAIL} isHistorical={false} />,
    );
    expect(figure(html, t("detail.overview.activeSchedules"))).toBe("1");
    expect(figure(html, t("detail.overview.archivedItems"))).toBe("1");
    expect(figure(html, t("detail.overview.pinnedItems"))).toBe("0");
  });
});

describe("the configuration view", () => {
  const label = () => i18n.t("detail.configuration.spaceLabel", { ns: "agents" });

  it("names the space whose configuration it shows in the mode, and offers the others", () => {
    const html = renderIn(
      true,
      <AgentConfigurationView packageId={PACKAGE_ID} detail={DETAIL} section="connections" />,
    );
    expect(html).toContain(label());
    expect(html).toContain("data-configuration-space");
    expect(html).toContain(">Atelier<");
    // Studio is configurable: the space can be changed.
    expect(html).toMatch(/data-configuration-space[\s\S]*<button/);
    expect(html).toContain(
      i18n.t("detail.configuration.connectionsDescriptionIn", { ns: "agents", space: "Atelier" }),
    );
  });

  it("names no space for the schedules, which span them", () => {
    const html = renderIn(
      true,
      <AgentConfigurationView packageId={PACKAGE_ID} detail={DETAIL} section="schedules" />,
    );
    expect(html).not.toContain("data-configuration-space");
  });

  it("CONTROL: names no space out of the mode", () => {
    const html = renderIn(
      false,
      <AgentConfigurationView packageId={PACKAGE_ID} detail={DETAIL} section="connections" />,
    );
    expect(html).not.toContain(label());
    expect(html).toContain(i18n.t("detail.configuration.connectionsDescription", { ns: "agents" }));
  });
});
