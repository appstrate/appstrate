// SPDX-License-Identifier: Apache-2.0

/**
 * The bell lists the notification feed by KIND: a share names the sharer and
 * the package and links to the package's sheet; a run that needs attention (it
 * failed or timed out) names its agent and status and links to the run.
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

type Notifications = Parameters<typeof NotificationContent>[0]["notifications"];

function renderList(
  notifications: Notifications,
  canReach: (target: string) => boolean = () => true,
): string {
  return render(
    <NotificationContent
      unread={notifications.length}
      notifications={notifications}
      agentName={(id) => (id === PACKAGE_ID ? "Worker" : undefined)}
      canReach={canReach}
      onItemClick={() => {}}
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
    // One share, one decision: the link opens THAT package's sheet.
    expect(html).toContain('href="/catalogue/agent?package=%40acme%2Fworker"');
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

    // A shared SKILL opens on its own kind, on the package itself.
    expect(html).toContain('href="/catalogue/skill?package=%40acme%2Fhelper"');
  });

  it("renders a failed run as its agent and status, linking to the run", () => {
    const html = renderList([
      {
        id: "n3",
        type: "run_failed",
        runId: "run_1",
        payload: { packageId: PACKAGE_ID, agent_name: "Stamped", status: "failed" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ]);

    expect(html).toContain("Worker");
    expect(html).not.toContain("Stamped");
    expect(html).toContain(`href="/agents/${PACKAGE_ID}/runs/run_1"`);
  });

  it("names an agent the list no longer holds by the name stamped on the run", () => {
    const html = renderList([
      {
        id: "n6",
        type: "run_failed",
        runId: "run_3",
        payload: { packageId: "@acme/switched-off", agent_name: "Hello World", status: "failed" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ]);

    expect(html).toContain("Hello World");
    expect(html).not.toContain("@acme/switched-off<");
  });

  // Notifications follow the session's ceiling: a caller can hold a share of a
  // package whose sheet would refuse them.
  it("links nowhere the caller cannot reach", () => {
    const notifications: Notifications = [
      {
        id: "n4",
        type: "run_failed",
        runId: "run_2",
        payload: { packageId: PACKAGE_ID, agent_name: "Stamped", status: "timeout" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
      {
        id: "n5",
        type: "package_shared",
        runId: null,
        payload: { packageId: PACKAGE_ID, package_type: "agent", shared_by_name: "Bob" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ];
    const denied = renderList(notifications, () => false);
    expect(denied).toContain("Worker");
    expect(denied).toContain(`Bob vous a partagé ${PACKAGE_ID}`);
    expect(denied).not.toContain("href=");
  });
});
