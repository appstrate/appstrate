// SPDX-License-Identifier: Apache-2.0

/**
 * The schedule's shared write against who it runs as. No write names the connection a fallback
 * binds — the server does (`withScheduleFallback`) — so none waits on a readiness verdict; the
 * write still waits on the fired version's declared integrations.
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
