// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's schedules, memory and configuration in « Tous les espaces »: the lists and the
 * figures cover every space the reader reaches, each row naming its space; the configuration,
 * kept per space, names the one it shows. With a space selected, each is that space's, unnamed.
 */

import { afterAll, describe, expect, it } from "bun:test";
import type {
  AgentDetail,
  AgentMemoryItem,
  AgentPinnedSlotItem,
  EnrichedSchedule,
} from "@appstrate/shared-types";
import { reporter } from "../../../test/agent-detail.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
});
await import("sonner");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: { classList: { add: () => {}, remove: () => {} } },
    querySelector: () => null,
  },
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "document");
});

const { default: i18n, i18nReady } = await import("../../../i18n.ts");
const { memberSpaceClient, renderInSpace, testSpace } =
  await import("../../../test/space-context.ts");
const { packageDetailQueryOptions } = await import("../../../hooks/use-packages.ts");
const { ACROSS_SPACES, persistenceKeys, scheduleKeys } = await import("../../../lib/query-keys.ts");
const { formatDateField } = await import("../../../lib/format-date.ts");
const { AgentSchedulesTab, AgentMemoryTab } = await import("../../package-detail/agent-tabs.tsx");
const { AgentOverviewTab } = await import("../agent-overview-tab.tsx");
const { AgentConfigurationView } = await import("../agent-configuration-view.tsx");
const { AgentSettingsView } = await import("../agent-settings-view.tsx");

await i18nReady;
await i18n.changeLanguage("fr");

const PACKAGE_ID = "@acme/reporter";
const READS = ["agents:read", "schedules:read", "persistence:read", "runs:read-all"];

/** The working space (Atelier, hidden in the mode), and Studio and Coffre where the agent runs. */
const SPACES = [
  testSpace("spc_a", READS),
  testSpace("spc_b", [
    ...READS,
    "agents:configure",
    "integrations:read",
    "schedules:write",
    "persistence:delete",
  ]),
  testSpace("spc_c", READS),
];

const DETAIL = reporter({ active: true });

function schedule(id: string, spaceId: string, nextRunAt: string): EnrichedSchedule {
  return {
    id,
    packageId: PACKAGE_ID,
    userId: "u_1",
    endUserId: null,
    orgId: "org_1",
    spaceId,
    name: `Tournée ${SPACES.find((s) => s.id === spaceId)?.name}`,
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

const memory = (id: number, spaceId: string, content: string): AgentMemoryItem => ({
  id,
  content,
  runId: null,
  actor_type: "shared",
  actor_id: null,
  createdAt: "2026-11-10T00:00:00Z",
  spaceId,
});

const pinned = (id: number, spaceId: string): AgentPinnedSlotItem => ({
  id,
  key: `slot_${id}`,
  content: "épinglé",
  runId: null,
  actor_type: "shared",
  actor_id: null,
  createdAt: "2026-11-10T00:00:00Z",
  updatedAt: "2026-11-10T00:00:00Z",
  spaceId,
});

/** Renders `node` in Atelier, the mode on or off, with both the lists spanning spaces and Atelier's seeded. */
function renderIn(
  overview: boolean,
  node: React.ReactElement,
  initialEntries?: string[],
  spaces: readonly unknown[] = SPACES,
) {
  const qc = memberSpaceClient(spaces);
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
    [memory(5, "spc_a", "Note d'Atelier")],
  );
  qc.setQueryData(
    persistenceKeys.list("org_1", "spc_a", "agent-pinned", PACKAGE_ID, { kind: "pinned" }),
    [],
  );
  return renderInSpace(node, { overview, queryClient: qc, initialEntries });
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
    // The soonest fire among them: Coffre's, on 1 December — not Studio's (2nd), nor the hidden
    // working space's (3rd). The figure leads with how soon, which moves with the clock: the date
    // it ends on is the one that names the schedule.
    const nextRun = figure(html, t("schedule.paramNextRun"));
    expect(nextRun).toEndWith(formatDateField("2026-12-01T09:00:00Z", "datetime", "UTC"));
    expect(nextRun).not.toEndWith(formatDateField("2026-12-02T09:00:00Z", "datetime", "UTC"));
  });

  it("CONTROL: count the working space's out of the mode", () => {
    const html = renderIn(
      false,
      <AgentOverviewTab packageId={PACKAGE_ID} detail={DETAIL} isHistorical={false} />,
    );
    expect(figure(html, t("detail.overview.activeSchedules"))).toBe("1");
    expect(figure(html, t("schedule.paramNextRun"))).toEndWith(
      formatDateField("2026-12-03T09:00:00Z", "datetime", "UTC"),
    );
    expect(figure(html, t("detail.overview.archivedItems"))).toBe("1");
    expect(figure(html, t("detail.overview.pinnedItems"))).toBe("0");
  });
});

/**
 * The markup of the configuration's space line: from its label's span to the line's own closing
 * tag, so an assertion on what the line holds is not met by a later part of the page.
 */
function configurationSpace(html: string): string | null {
  const label = i18n.t("detail.configuration.spaceLabel", { ns: "agents" });
  const marker = html.indexOf(`>${label}</span>`);
  if (marker < 0) return null;
  const start = html.lastIndexOf("<div", marker);
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.lastIndex);
  }
  return null;
}

describe("the configuration view", () => {
  const label = () => i18n.t("detail.configuration.spaceLabel", { ns: "agents" });
  // Active in Atelier, the working space, and in Studio.
  const placedHere: AgentDetail = {
    ...DETAIL,
    space_ids: ["spc_a", "spc_b"],
    read_space_ids: ["spc_a", "spc_b"],
  };

  it("names the space whose configuration it shows in the mode, and offers the others", () => {
    const html = renderIn(
      true,
      <AgentConfigurationView
        packageId={PACKAGE_ID}
        detail={placedHere}
        section="connections"
        permission="integrations:read"
      />,
    );
    expect(html).toContain(label());
    const line = configurationSpace(html);
    // The line names Atelier, then the one other space granting it, entered at a click.
    expect(line).toContain(">Atelier<");
    expect(line).toContain(
      `>${i18n.t("detail.configuration.spaceChoiceIn", { ns: "agents", space: "Studio" })}</button>`,
    );
    expect(html).toContain(
      i18n.t("detail.configuration.connectionsDescriptionIn", { ns: "agents", space: "Atelier" }),
    );
  });

  it("never names a working space the header does not: it asks for one of the agent's", () => {
    // Active in Studio and Coffre only, as the header's tiles say; both read its integrations.
    const html = renderIn(
      true,
      <AgentConfigurationView
        packageId={PACKAGE_ID}
        detail={DETAIL}
        section="connections"
        permission="integrations:read"
      />,
      undefined,
      [SPACES[0], SPACES[1], testSpace("spc_c", [...READS, "integrations:read"])],
    );
    const line = configurationSpace(html);
    expect(line).toContain(i18n.t("detail.configuration.pickSpace", { ns: "agents" }));
    expect(line).toMatch(/<button/);
    expect(line).not.toContain(">Atelier<");
  });

  it("names the one other space it enters at a click, and the working space no more", () => {
    // Active in Studio alone, where configuring is granted.
    const html = renderIn(
      true,
      <AgentConfigurationView
        packageId={PACKAGE_ID}
        detail={{ ...DETAIL, space_ids: ["spc_b"], read_space_ids: ["spc_b"] }}
        section="model"
        permission="agents:configure"
      />,
    );
    const line = configurationSpace(html);
    expect(line).toContain(
      `>${i18n.t("detail.configuration.spaceChoiceIn", { ns: "agents", space: "Studio" })}</button>`,
    );
    expect(line).not.toContain(i18n.t("detail.configuration.pickSpace", { ns: "agents" }));
    expect(line).not.toContain(">Atelier<");
    // The button is described by the line's label.
    const labelId = line?.match(/<span id="([^"]+)"/)?.[1];
    expect(line).toContain(`aria-describedby="${labelId}"`);
  });

  it("asks among the agent's active spaces, not a switched-off placement in the hidden one", () => {
    // Readable in Atelier, switched off there: not a header tile, never named.
    const html = renderIn(
      true,
      <AgentConfigurationView
        packageId={PACKAGE_ID}
        detail={{ ...DETAIL, read_space_ids: ["spc_a", "spc_b", "spc_c"] }}
        section="connections"
        permission="integrations:read"
      />,
    );
    expect(configurationSpace(html)).not.toContain(">Atelier<");
  });

  it("names no space for the schedules, which span them", () => {
    const html = renderIn(
      true,
      <AgentConfigurationView packageId={PACKAGE_ID} detail={DETAIL} section="schedules" />,
    );
    expect(configurationSpace(html)).toBeNull();
  });

  it("CONTROL: names no space out of the mode", () => {
    const html = renderIn(
      false,
      <AgentConfigurationView
        packageId={PACKAGE_ID}
        detail={placedHere}
        section="connections"
        permission="integrations:read"
      />,
    );
    expect(configurationSpace(html)).toBeNull();
    expect(html).toContain(i18n.t("detail.configuration.connectionsDescription", { ns: "agents" }));
  });
});

describe("the settings rail when the hidden space refuses configuring", () => {
  // Atelier (working, hidden) reads but does not configure; Studio configures.
  const placedHere = {
    ...DETAIL,
    space_ids: ["spc_a", "spc_b"],
    read_space_ids: ["spc_a", "spc_b"],
    etag: null,
  };
  const settings = (overview: boolean) =>
    renderIn(
      overview,
      <AgentSettingsView
        packageId={PACKAGE_ID}
        detail={placedHere}
        isHistorical={false}
        versions={{ canRestore: false, canDelete: false }}
      />,
      ["/agents/@acme/reporter?agentSettings=model#settings"],
    );
  const t = (key: string, options?: Record<string, string>) =>
    i18n.t(key, { ns: "agents", ...options });

  it("opens the section another of the agent's spaces grants, with the way to it", () => {
    const html = settings(true);
    expect(configurationSpace(html)).not.toBeNull();
    expect(html).toContain(t("detail.roleLimit.sectionIn", { space: "Atelier" }));
    expect(html).not.toContain(t("detail.roleLimit.section"));
  });

  it("never names the hidden space in its notice when the header does not show it", () => {
    // The files, read in the agent's placements; Atelier (hidden) refuses them and is none of them.
    const html = renderIn(
      true,
      <AgentSettingsView
        packageId={PACKAGE_ID}
        detail={{ ...DETAIL, etag: null }}
        isHistorical={false}
        versions={{ canRestore: false, canDelete: false }}
      />,
      ["/agents/@acme/reporter?agentSettings=files#settings"],
      [testSpace("spc_a", []), ...SPACES.slice(1)],
    );
    expect(html).not.toContain(t("detail.roleLimit.sectionIn", { space: "Atelier" }));
    expect(html).toContain(t("detail.configuration.pickSpaceHint"));
  });

  it("CONTROL: is a role limit out of the mode, the working space's verdict", () => {
    const html = settings(false);
    expect(html).toContain(t("detail.roleLimit.section"));
    expect(configurationSpace(html)).toBeNull();
  });
});
