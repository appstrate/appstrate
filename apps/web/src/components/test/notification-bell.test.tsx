// SPDX-License-Identifier: Apache-2.0

/**
 * The bell lists the notification feed by KIND: a share names the sharer and
 * the package; a run that needs attention (it failed or timed out) names its
 * agent and status; an `agent_message` reads as the message its agent wrote.
 * A row leads to the page that marks it read: the run for a failed run, the
 * notification's own page for every other kind.
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
      onNavigate={() => {}}
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
    // The share's own page, which links on to the package's sheet.
    expect(html).toContain('href="/notifications/n1"');
    // Not a run: no run-scoped link, and nothing that reads as a dead agent.
    expect(html).not.toContain("Agent supprimé");
    expect(html).not.toContain('href="/runs/');
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

  it("renders an `agent_message` row as the agent's title and message, linked to its run", () => {
    const html = renderList([
      {
        id: "n7",
        type: "agent_message",
        runId: "run_4",
        payload: {
          packageId: PACKAGE_ID,
          agent_name: "Worker (stamped)",
          title: "Factures prêtes",
          message: "12 factures attendent votre relecture.",
        },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ]);

    expect(html).toContain("Factures prêtes");
    expect(html).toContain("12 factures attendent votre relecture.");
    // The sender is named by the agent's display name; the row opens the message's
    // own page, not the run: viewing the run does not read the message.
    expect(html).toContain("Message de Worker");
    expect(html).toContain('href="/notifications/n7"');
    expect(html).not.toContain(`href="/agents/${PACKAGE_ID}/runs/run_4"`);
  });

  it("names the sender of an `agent_message` from an unlisted agent by the name stamped on its run", () => {
    const html = renderList([
      {
        id: "n9",
        type: "agent_message",
        runId: "run_6",
        payload: {
          packageId: "@inline/r-1",
          agent_name: "Contrôle des factures",
          title: "Terminé",
          message: "Rien à signaler.",
        },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ]);

    expect(html).toContain("Message de Contrôle des factures");
    expect(html).not.toContain("Message de @inline");
  });

  it("titles an `agent_message` row without a payload by its agent's label", () => {
    const html = renderList([
      {
        id: "n8",
        type: "agent_message",
        runId: "run_5",
        payload: null,
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ]);

    const label = i18n.t("runs.deletedAgent", { ns: "agents" });
    // The title, then the sender line.
    expect(html.split(label)).toHaveLength(3);
  });

  // Notifications follow the session's ceiling: a caller can hold a failure
  // notice of a run whose page would refuse them. It opens the notification's
  // own page instead, which reads it.
  it("opens the notification's page when the run's page is closed to the caller", () => {
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
    expect(denied).toContain('href="/notifications/n4"');
    expect(denied).toContain('href="/notifications/n5"');
    expect(denied).not.toContain('href="/agents/');
  });

  it("offers the next page only when the feed has one", () => {
    const row: Notifications = [
      {
        id: "n6",
        type: "run_failed",
        runId: "run_3",
        payload: { packageId: PACKAGE_ID, agent_name: null, status: "failed" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ];
    const list = (hasMore: boolean) =>
      render(
        <NotificationContent
          unread={1}
          notifications={row}
          agentName={() => "Worker"}
          canReach={() => true}
          onNavigate={() => {}}
          markAllRead={() => {}}
          hasMore={hasMore}
          onLoadMore={() => {}}
        />,
      );
    expect(list(true)).toContain("Afficher plus");
    expect(list(false)).not.toContain("Afficher plus");
  });
});
