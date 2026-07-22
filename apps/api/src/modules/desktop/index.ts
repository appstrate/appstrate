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
 * Disabled (not in `MODULES`): zero footprint — no routes, and the
 * `desktop_browser` tool (always present in runtime images) surfaces a
 * clean 404 to the agent. The module owns no tables: connected clients
 * live in an in-memory registry keyed by userId.
 */

import { z } from "zod";
import type { AppstrateModule } from "@appstrate/core/module";
import { createDesktopRouter, desktopCommandSchema, desktopAgentCommandSchema } from "./routes.ts";
import { closeAllClients, setNotificationHandler } from "./registry.ts";
import { handleDesktopNotification } from "./downloads.ts";
import { desktopPaths } from "./openapi/paths.ts";
import { desktopSchemas } from "./openapi/schemas.ts";

const desktopModule: AppstrateModule = {
  manifest: { id: "desktop", name: "Desktop Bridge", version: "1.0.0" },

  async init() {
    // The module owns no tables; the only wiring is the notification
    // intake — desktop-initiated JSON-RPC notifications (download
    // lifecycle) flow from the WS registry into the downloads service.
    setNotificationHandler(handleDesktopNotification);
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

  async shutdown() {
    setNotificationHandler(null);
    closeAllClients();
  },
};

export default desktopModule;
