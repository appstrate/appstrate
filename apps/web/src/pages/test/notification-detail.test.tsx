// SPDX-License-Identifier: Apache-2.0

/**
 * A notification's page in « Tous les espaces »: the bell links a notification of another space
 * with `?enterSpace=`, so the gate waits until that space is entered, never reading it in the
 * hidden working space, and the page then reads it in its own space, as a reload does once the
 * space is remembered. The route keeps the mode.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { default: i18n, i18nReady } = await import("../../i18n.ts");
const { NotificationDetailPage } = await import("../notification-detail.tsx");
const { RouteGate } = await import("../../components/route-gate.tsx");
const { renderInSpace } = await import("../../test/space-context.ts");
const { holdsOverview } = await import("../../lib/space-lists.ts");

await i18nReady;
await i18n.changeLanguage("fr");

const space = (id: string, name: string) => ({
  id,
  object: "space",
  access: "member",
  permissions: ["runs:read"],
  personal: false,
  isDefault: id === "spc_a",
  name,
  role: null,
});
const SPACES = [space("spc_a", "Studio"), space("spc_b", "Coffre")];

const NOTIFICATION = {
  id: "11111111-1111-4111-8111-111111111111",
  spaceId: "spc_b",
  type: "agent_message",
  runId: "run_1",
  payload: { packageId: "@acme/worker", agent_name: "Worker", title: "Prêt", message: "Fini." },
  read_at: "2026-09-10T10:05:00.000Z",
  createdAt: "2026-09-10T10:00:00.000Z",
};

function renderAt(url: string, workingSpaceId: string) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }],
    {
      object: "list",
      hasMore: false,
      data: SPACES,
    },
  );
  // The notification as its own space answers it; the hidden working space would answer 404.
  queryClient.setQueryData(
    [
      "get",
      "/api/notifications/{id}",
      {
        params: {
          header: { "X-Org-Id": "org_1", "X-Space-Id": "spc_b" },
          path: { id: NOTIFICATION.id },
        },
      },
    ],
    NOTIFICATION,
  );
  return renderInSpace(
    <Routes>
      <Route
        path="/notifications/:id"
        element={
          <RouteGate path="/notifications/:id" pending={<p>pending</p>}>
            <NotificationDetailPage />
          </RouteGate>
        }
      />
    </Routes>,
    { overview: true, spaceId: workingSpaceId, queryClient, initialEntries: [url] },
  );
}

describe("a notification of another space, in « Tous les espaces »", () => {
  it("keeps the mode on its page", () => {
    expect(holdsOverview("/notifications/:id")).toBe(true);
  });

  it("waits for its space to be entered, never reading it in the hidden working space", () => {
    const html = renderAt(`/notifications/${NOTIFICATION.id}?enterSpace=spc_b`, "spc_a");
    expect(html).toContain("pending");
    expect(html).not.toContain("Fini.");
  });

  it("reads it in its own space once entered, as a reload does", () => {
    const html = renderAt(`/notifications/${NOTIFICATION.id}`, "spc_b");
    // The message body: the page read the notification (the bar renders in the shell's slot).
    expect(html).toContain("Fini.");
  });
});
