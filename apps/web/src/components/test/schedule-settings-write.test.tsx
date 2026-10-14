// SPDX-License-Identifier: Apache-2.0

/**
 * The schedule's shared write against who it runs as. An armed schedule's write names the
 * connection the fallback binds, from the viewer's readiness verdict — so that verdict is asked
 * only for a schedule running as the viewer, and never lands on someone else's schedule.
 */

import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { ReactElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import { installFakeStorage } from "../../test/fake-storage.ts";

// Registered before the fake storage's own teardown, so it runs first.
afterAll(() => getSession.mockRestore());

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { origin: "https://app.example.test" },
});

const { ScheduleActionsMenu, ScheduleSettings } = await import("../schedule-settings.tsx");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const { authClient } = await import("../../lib/auth-client.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { startAuthBootstrap } = await import("../../hooks/use-auth.ts");

// `useAuth()` would start the session resync mid-suite: start it here, answered at once (no
// session), and let it settle before any test, while the fake storage it clears exists.
const getSession = spyOn(authClient, "getSession").mockResolvedValue({
  data: null,
  error: null,
});
startAuthBootstrap();
for (let i = 0; i < 5000 && authStore.getState().loading; i++) await Bun.sleep(1);

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

describe("ScheduleSettings — whose readiness verdict is asked", () => {
  it("does not ask the viewer's verdict for a schedule running as someone else", () => {
    expect(asksReadiness(renderAs("usr_alice"))).toBe(false);
  });

  it("asks it for a schedule running as the viewer", () => {
    expect(asksReadiness(renderAs("usr_bob"))).toBe(true);
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
    expect(asksReadiness(qc)).toBe(true);
  });
});
