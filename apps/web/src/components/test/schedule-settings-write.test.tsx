// SPDX-License-Identifier: Apache-2.0

/**
 * The schedule's shared write against who it runs as. No write names the connection a fallback
 * binds — the server does (`withScheduleFallback`) — so none waits on a readiness verdict; the
 * write still waits on the fired version's declared integrations.
 */

import { describe, expect, it, spyOn } from "bun:test";
import type { ReactElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});

const { ScheduleActionsMenu, ScheduleSettings } = await import("../schedule-settings.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const schedulesGovernance = await import("../../lib/schedule-governance.ts");
const { orgStore } = await import("../../stores/org-store.ts");

// Signed out, the session read settled: the state the boot resync leaves without a session.
authStore.setState({ user: null, profile: null, loading: false });

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const VERSION = "1.0.0";

const SCHEDULE: ScheduleWireDto = {
  id: "sch_1",
  packageId: "@acme/mailer",
  userId: "usr_bob",
  endUserId: null,
  orgId: "org_1",
  spaceId: "spc_1",
  name: "Daily",
  enabled: true,
  disabled_reason: null,
  cron_expression: "0 9 * * *",
  timezone: "UTC",
  input: null,
  generation_config_override: null,
  model_id_override: null,
  proxy_id_override: null,
  version_override: VERSION,
  connection_overrides: null,
  dependency_overrides: null,
  last_run_at: null,
  next_run_at: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

/** Whether the page mounted the agent's readiness query for the fired version. */
function asksReadiness(qc: QueryClient): boolean {
  return qc
    .getQueryCache()
    .getAll()
    .some(({ queryKey: [, path, init] }) => {
      const params = (init as { params?: { path?: { name?: string }; query?: unknown } })?.params;
      return (
        path === "/api/agents/{scope}/{name}/connection-readiness" &&
        params?.path?.name === "mailer" &&
        Bun.deepEquals(params.query, { version: VERSION })
      );
    });
}

/** Renders `node` (the schedule of `usr_bob`) as seen by `viewerId`. */
function renderAs(
  viewerId: string,
  node: ReactElement = <ScheduleSettings schedule={SCHEDULE} />,
): QueryClient {
  const qc = new QueryClient();
  // `renderToStaticMarkup` reads zustand's server snapshot, not its live state.
  const snapshot = spyOn(authStore, "getInitialState").mockReturnValue({
    ...authStore.getInitialState(),
    user: { id: viewerId, email: "viewer@acme.test", emailVerified: true },
  });
  try {
    render(node, { queryClient: qc });
  } finally {
    snapshot.mockRestore();
  }
  return qc;
}

/** Whether the page mounted the agent's detail query (a `packages` key) for the fired version. */
function asksFiredDetail(qc: QueryClient): boolean {
  return qc
    .getQueryCache()
    .getAll()
    .some(({ queryKey }) => queryKey[0] === "packages" && queryKey.includes(VERSION));
}

describe("ScheduleSettings — a write names no fallback", () => {
  // The server names the connection a fallback binds (`withScheduleFallback`), so no write
  // waits on the viewer's verdict, whoever the schedule runs as.
  it("asks no readiness verdict for a schedule running as the viewer", () => {
    expect(asksReadiness(renderAs("usr_bob"))).toBe(false);
  });

  it("asks none for a schedule running as someone else", () => {
    expect(asksReadiness(renderAs("usr_alice"))).toBe(false);
  });
});

describe("ScheduleActionsMenu — the enable/disable write", () => {
  it("asks the facts it arms with when the page mounts, not when the menu opens", () => {
    // The menu is closed in a static render: only a write held by the menu
    // itself, rather than by its item, has asked anything yet.
    const qc = renderAs(
      "usr_bob",
      <ScheduleActionsMenu schedule={SCHEDULE} onDelete={() => {}} deletePending={false} />,
    );
    expect(asksFiredDetail(qc)).toBe(true);
  });
});

const ORG_ID = "org_1";

/** The menu of `SCHEDULE` as `viewerId` sees it, holding `permissions` in the org. */
function menuAs(viewerId: string, permissions: string[]): string {
  const qc = new QueryClient();
  qc.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: "member",
        permissions,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  );
  const org = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  const auth = spyOn(authStore, "getInitialState").mockReturnValue({
    ...authStore.getInitialState(),
    user: { id: viewerId, email: "viewer@acme.test", emailVerified: true },
  });
  try {
    return render(
      <ScheduleActionsMenu schedule={SCHEDULE} onDelete={() => {}} deletePending={false} />,
      { queryClient: qc },
    );
  } finally {
    org.mockRestore();
    auth.mockRestore();
  }
}

describe("ScheduleActionsMenu — who gets a menu", () => {
  it("offers the menu to an owner holding schedules:delete without schedules:write", () => {
    // The personal-space `operator` cap: delete rights only, so the member can still remove
    // a schedule that keeps firing. The menu's content is a portal; the trigger is its proof.
    expect(menuAs("usr_bob", ["schedules:delete", "agents:run"])).toContain(
      "data-page-actions-trigger",
    );
  });

  it("offers no menu to a caller holding neither right", () => {
    expect(menuAs("usr_bob", ["agents:run"])).toBe("");
  });

  it("offers no menu for delete alone on a schedule the caller does not govern", () => {
    expect(menuAs("usr_alice", ["schedules:delete"])).toBe("");
  });

  it("keeps the menu for a caller holding schedules:write", () => {
    expect(menuAs("usr_bob", ["schedules:write"])).toContain("data-page-actions-trigger");
  });
});

describe("scheduleMenuActions — what the menu would contain", () => {
  const { scheduleMenuActions } = schedulesGovernance;

  it("delete right alone: Supprimer only, no enable/disable", () => {
    expect(scheduleMenuActions({ write: false, delete: true, governs: true })).toEqual({
      toggle: false,
      delete: true,
    });
  });

  it("write right alone: enable/disable only", () => {
    expect(scheduleMenuActions({ write: true, delete: false, governs: true })).toEqual({
      toggle: true,
      delete: false,
    });
  });

  it("both rights: both, as before", () => {
    expect(scheduleMenuActions({ write: true, delete: true, governs: true })).toEqual({
      toggle: true,
      delete: true,
    });
  });

  it("neither right, or no governance: nothing (the server refuses both)", () => {
    expect(scheduleMenuActions({ write: false, delete: false, governs: true })).toEqual({
      toggle: false,
      delete: false,
    });
    expect(scheduleMenuActions({ write: true, delete: true, governs: false })).toEqual({
      toggle: false,
      delete: false,
    });
  });
});
