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
import { QueryClient } from "@tanstack/react-query";
import { $api } from "../../api/client.ts";
import { render } from "../../test/render.tsx";
import { NotificationContent } from "../notification-bell.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const PACKAGE_ID = "@acme/worker";
/** The working space, where every fixture lives unless a test says otherwise. */
const SPACE = "spc_here";
const OTHER_SPACE = "spc_there";

type Notifications = Parameters<typeof NotificationContent>[0]["notifications"];

function renderList(
  notifications: Notifications,
  canReach: (target: string, spaceId: string | undefined) => boolean = () => true,
): string {
  return render(
    <NotificationContent
      unread={notifications.length}
      notifications={notifications}
      agentName={(id) => (id === PACKAGE_ID ? "Worker" : undefined)}
      canReach={canReach}
      currentSpaceId={SPACE}
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
        spaceId: SPACE,
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

  it("renders an `integration_tools_review` row as the integration to review, on its own page", () => {
    const html = renderList([
      {
        id: "n20",
        spaceId: SPACE,
        type: "integration_tools_review",
        runId: null,
        payload: { packageId: "@acme/notion", display_name: "Notion" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ]);

    expect(html).toContain("Outils à examiner : Notion");
    expect(html).toContain('href="/notifications/n20"');
    expect(html).not.toContain("Agent supprimé");
  });

  it("renders a failed run as its agent and status, linking to the run", () => {
    const html = renderList([
      {
        id: "n3",
        spaceId: SPACE,
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
        spaceId: SPACE,
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
        spaceId: SPACE,
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
        spaceId: SPACE,
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
        spaceId: SPACE,
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
        spaceId: SPACE,
        type: "run_failed",
        runId: "run_2",
        payload: { packageId: PACKAGE_ID, agent_name: "Stamped", status: "timeout" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
      {
        id: "n5",
        spaceId: SPACE,
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
        spaceId: SPACE,
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
          currentSpaceId={SPACE}
          onItemClick={() => {}}
          markAllRead={() => {}}
          hasMore={hasMore}
          onLoadMore={() => {}}
        />,
      );
    expect(list(true)).toContain("Afficher plus");
    expect(list(false)).not.toContain("Afficher plus");
  });
  describe("« Tous les espaces »", () => {
    const rows: Notifications = [
      {
        id: "n10",
        spaceId: OTHER_SPACE,
        type: "run_failed",
        runId: "run_10",
        payload: { packageId: PACKAGE_ID, agent_name: null, status: "failed" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
      {
        id: "n11",
        spaceId: OTHER_SPACE,
        type: "agent_message",
        runId: "run_11",
        payload: { packageId: PACKAGE_ID, agent_name: null, title: "Prêt", message: "Fini." },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
      {
        id: "n12",
        spaceId: SPACE,
        type: "package_shared",
        runId: null,
        payload: { packageId: PACKAGE_ID, package_type: "agent", shared_by_name: "Bob" },
        read_at: null,
        createdAt: "2026-09-10T10:00:00.000Z",
      },
    ];

    function renderSpanning(): string {
      const queryClient = new QueryClient();
      const spacesKey = $api.queryOptions("get", "/api/spaces", {
        params: { header: { "X-Org-Id": undefined } },
      }).queryKey;
      queryClient.setQueryData(spacesKey, {
        object: "list",
        data: [
          { id: SPACE, name: "Studio", access: "member", permissions: [] },
          { id: OTHER_SPACE, name: "Coffre", access: "member", permissions: [] },
        ],
        hasMore: false,
      });
      return render(
        <NotificationContent
          unread={rows.length}
          notifications={rows}
          agentName={() => "Worker"}
          canReach={() => true}
          currentSpaceId={SPACE}
          spanning
          onItemClick={() => {}}
          markAllRead={() => {}}
        />,
        { queryClient },
      );
    }

    it("names each row's space", () => {
      const html = renderSpanning();
      expect(html.split(">Coffre<")).toHaveLength(3);
      expect(html.split(">Studio<")).toHaveLength(2);
    });

    it("opens a notification of another space in that space: its run, or its own page", () => {
      const html = renderSpanning();
      expect(html).toContain(`href="/agents/${PACKAGE_ID}/runs/run_10?enterSpace=${OTHER_SPACE}"`);
      expect(html).toContain(`href="/notifications/n11?enterSpace=${OTHER_SPACE}"`);
      // The working space's own row moves nowhere.
      expect(html).toContain('href="/notifications/n12"');
    });

    it("names no space with a space selected", () => {
      const html = renderList(rows);
      expect(html).not.toContain("Coffre");
    });
  });
});
