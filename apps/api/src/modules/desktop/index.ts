// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop module — bridge between platform-hosted agents and a Chromium
 * surface running on the user's own machine (the Appstrate Desktop
 * Electron companion, `apps/desktop/`).
 *
 * When loaded, registers:
 *   - the WebSocket bridge (`/api/desktop/bridge`) desktop clients
 *     connect to,
 *   - the user-scoped status/command surface (`/api/desktop/me/*`),
 *   - the sidecar-facing `/internal/desktop-command` endpoint that backs
 *     the `desktop_browser` runtime tool, with server-side credential
 *     substitution so agents never see secret values.
 *
 * Disabled (not in `MODULES`): zero API footprint. The sidecar exposes
 * desktop tools only for agents that selected the manifest capability.
 * The module owns no tables: connected clients live in an in-memory
 * registry keyed by userId.
 */

import { z } from "zod";
import type { AppstrateModule, RunStatusChangeParams } from "@appstrate/core/module";
import {
  createDesktopRouter,
  desktopCommandSchema,
  desktopAgentCommandSchema,
  clearRunDesktopPolicy,
} from "./routes.ts";
import { closeAllClients, sendCommand, setNotificationHandler } from "./registry.ts";
import {
  clearDownloadsForRun,
  handleDesktopNotification,
  startDownloadSweeper,
  stopDownloadSweeper,
} from "./downloads.ts";
import { clearRunSecrets } from "./secret-scrub.ts";
import { clearRunEphemeralCredentials } from "../../services/run-ephemeral-credentials.ts";
import {
  clearDesktopLeases,
  handleDesktopTabNotification,
  releaseDesktopLeaseByRun,
} from "./lease.ts";
import { desktopPaths } from "./openapi/paths.ts";
import { desktopSchemas } from "./openapi/schemas.ts";

const desktopModule: AppstrateModule = {
  manifest: { id: "desktop", name: "Desktop Bridge", version: "1.0.0" },

  async init() {
    // The module owns no tables; the only wiring is the notification
    // intake — desktop-initiated JSON-RPC notifications flow from the WS
    // registry into the tab leases (a person closing or taking over a
    // tab) and the downloads service (transfer lifecycle).
    setNotificationHandler((userId, method, params) => {
      if (method.startsWith("tab.")) {
        handleDesktopTabNotification(userId, method, params);
        return;
      }
      handleDesktopNotification(userId, method, params);
    });
    startDownloadSweeper();
  },

  createRouter() {
    return createDesktopRouter();
  },

  openApiPaths() {
    return desktopPaths;
  },

  openApiComponentSchemas() {
    return desktopSchemas;
  },

  openApiSchemas() {
    return [
      {
        method: "POST",
        path: "/api/desktop/me/command",
        jsonSchema: z.toJSONSchema(desktopCommandSchema) as Record<string, unknown>,
        description: "Drive my desktop",
      },
      {
        method: "POST",
        path: "/internal/desktop-command",
        jsonSchema: z.toJSONSchema(desktopAgentCommandSchema) as Record<string, unknown>,
        description: "Agent desktop command",
      },
    ];
  },

  openApiTags() {
    return [
      {
        name: "Desktop",
        description: "Bridge to the user's local Appstrate Desktop browser surface",
      },
    ];
  },

  features: { desktop: true },

  events: {
    onRunStatusChange: async (params: RunStatusChangeParams) => {
      if (params.status === "started") return;
      const releasedTabs = releaseDesktopLeaseByRun(params.runId);
      clearRunSecrets(params.runId);
      clearRunEphemeralCredentials(params.runId);
      clearRunDesktopPolicy(params.runId);
      clearDownloadsForRun(params.runId);
      // Close what the run opened rather than blanking a shared surface.
      // For an `isolated` agent this is also what destroys its throwaway
      // profile: the partition dies with its last view.
      await Promise.allSettled(
        releasedTabs.map(({ userId, tabId }) =>
          sendCommand(userId, "tabs.close", { tab_id: tabId }, { timeoutMs: 5_000 }),
        ),
      );
    },
  },

  async shutdown() {
    setNotificationHandler(null);
    stopDownloadSweeper();
    closeAllClients();
    clearDesktopLeases();
    clearRunDesktopPolicy();
  },
};

export default desktopModule;
