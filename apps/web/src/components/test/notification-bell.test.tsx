// SPDX-License-Identifier: Apache-2.0

/**
 * The bell's list reads by notification KIND (`notifications.type`), not by
 * assuming every row is a finished run.
 *
 * `package_shared` has no run and no status behind it, so a row that reached
 * for `payload.agent_id` fell through to `runs.deletedAgent` and announced a
 * share as "Agent supprimé", linking to `/runs`. These two cases pin the
 * branch and its control: the share names the sharer and the package and links
 * to the package's detail page, and a run notification is unchanged.
 *
 * Same no-DOM harness as the other component suites — `renderToStaticMarkup`
 * through the SPA's own i18n singleton, so the assertions read the bundle
 * strings the user sees.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { NotificationContent } from "../notification-bell.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const PACKAGE_ID = "@acme/worker";

function renderList(
  notifications: Parameters<typeof NotificationContent>[0]["notifications"],
): string {
  return render(
    <NotificationContent
      unread={notifications.length}
      notifications={notifications}
      agentNameMap={new Map([[PACKAGE_ID, "Worker"]])}
      onItemClick={() => {}}
      onClose={() => {}}
      markAllRead={() => {}}
    />,
  );
}

describe("NotificationContent", () => {
  it("renders a `package_shared` row as the share it is", () => {
    const html = renderList([
      {
        id: "n1",
        type: "package_shared",
        runId: null,
        payload: {
          packageId: PACKAGE_ID,
          package_type: "agent",
          shared_by_name: "Alice Martin",
        },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ]);

    expect(html).toContain(`Alice Martin vous a partagé ${PACKAGE_ID}`);
    // The current space view has the acceptance action, regardless of type.
    expect(html).toContain('href="/space/packages"');
    // Not a run: no run-scoped link, and nothing that reads as a dead agent.
    expect(html).not.toContain("Agent supprimé");
    expect(html).not.toContain('href="/runs/');
  });

  it("routes a shared skill to the local acceptance view", () => {
    const html = renderList([
      {
        id: "n2",
        type: "package_shared",
        runId: null,
        payload: { packageId: "@acme/helper", package_type: "skill", shared_by_name: "Bob" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ]);

    expect(html).toContain('href="/space/packages"');
  });

  it("still renders a run notification as the agent and its status", () => {
    const html = renderList([
      {
        id: "n3",
        type: "run_completed",
        runId: "run_1",
        payload: { agent_id: PACKAGE_ID, status: "success" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ]);

    expect(html).toContain("Worker");
    expect(html).toContain(`href="/agents/${PACKAGE_ID}/runs/run_1"`);
  });
});
