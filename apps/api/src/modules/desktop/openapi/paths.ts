// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate Desktop bridge — the companion app that exposes a Chromium
 * surface on the user's own machine to platform-hosted agents.
 *
 * `/bridge` is a WebSocket upgrade, which OpenAPI cannot express as a
 * protocol switch; it is documented as the `GET` that carries the
 * `Upgrade` handshake so the endpoint is discoverable and covered by
 * the Code ⊆ Spec check.
 */

export const desktopPaths = {
  "/api/desktop/bridge": {
    get: {
      operationId: "connectDesktopBridge",
      tags: ["Desktop"],
      summary: "Open the desktop bridge WebSocket",
      description:
        "WebSocket upgrade. The Appstrate Desktop client connects here with the Better Auth session cookie of the webapp pane it embeds; the resolved user is registered as the owner of that bridge. One connection per user — a new one displaces the previous. Org context is not required (a desktop belongs to a person, not an organization). Over the socket the platform sends `{ id, method, params }` frames and the client replies `{ id, result }` or `{ id, error }`.",
      responses: {
        "101": { description: "Switching protocols — the bridge is open." },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/desktop/me/status": {
    get: {
      operationId: "getMyDesktopStatus",
      tags: ["Desktop"],
      summary: "Check whether my desktop companion is connected",
      responses: {
        "200": {
          description: "Connection status of the caller's desktop companion.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DesktopStatusResponse" },
              example: { connected: true },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/desktop/me/command": {
    post: {
      operationId: "sendMyDesktopCommand",
      tags: ["Desktop"],
      summary: "Drive my desktop companion's browser",
      description:
        "Executes a browser primitive on the caller's own desktop client and returns the correlated reply. Not on the agent execution path — agents use the `desktop_browser` tool, which goes through `/internal/desktop-command` — but this is the fastest way to smoke-test a bridge without starting a run.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/DesktopCommandRequest" },
            example: { method: "browser.navigate", params: { url: "https://example.com" } },
          },
        },
      },
      responses: {
        "200": {
          description: "The desktop's reply to the command.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DesktopCommandResponse" },
              example: { result: { url: "https://example.com" } },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "502": {
          description: "The desktop reported an error executing the command.",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
          },
        },
        "503": {
          description: "No desktop companion is connected for this user.",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
          },
        },
        "504": {
          description: "The desktop did not reply before the timeout elapsed.",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
          },
        },
      },
    },
  },
  "/internal/desktop-command": {
    post: {
      operationId: "dispatchDesktopCommand",
      tags: ["Desktop"],
      summary: "Dispatch a browser command to the run owner's desktop companion",
      description:
        "Backs the agent-facing `desktop_browser` MCP tool. Forwards a JSON-RPC command to the Appstrate Desktop client connected for the run's owning user and returns the correlated reply inline. Container-to-host only. Auth via Bearer run token. A run with no owning user (remote or end-user triggered) has no desktop to drive and gets a 403. Supports server-side credential substitution (`integrationId` + `substituteParams`): `{{field}}` placeholders in `params` are resolved from the run's connected credentials for the declared integration, and every reply for the run is scrubbed of the substituted values.",
      security: [{ bearerExecToken: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/DesktopAgentCommandRequest" },
            example: {
              method: "browser.fill",
              params: { selector: "#password", value: "{{password}}" },
              integrationId: "@myorg/somesite",
              substituteParams: true,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The desktop's reply to the command (scrubbed of substituted values).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DesktopCommandResponse" },
              example: { result: { filled: true } },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
        "502": {
          description: "The desktop reported an error executing the command.",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
          },
        },
        "503": {
          description: "No desktop companion is connected for this user.",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
          },
        },
        "504": {
          description: "The desktop did not reply before the timeout elapsed.",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
          },
        },
      },
    },
  },
} as const;
