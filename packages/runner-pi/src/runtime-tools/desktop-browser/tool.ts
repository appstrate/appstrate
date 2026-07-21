// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `desktop_browser` runtime-injected tool — the single source of truth
 * for the tool's LLM-facing contract (name + description + parameter
 * JSON Schema).
 *
 * Drives the run owner's local Chromium surface through the Appstrate
 * Desktop bridge: the sidecar forwards the command to
 * `/internal/desktop-command`, the platform looks up the owner's
 * connected desktop WebSocket and awaits the correlated reply. The
 * handler-side implementation lives in the sidecar
 * (`runtime-pi/sidecar/mcp.ts`), which mirrors this descriptor's
 * `description` + `parameters` (as its MCP `inputSchema`) verbatim.
 *
 * The supported methods mirror the browser primitives implemented in
 * `apps/desktop/src/bridge/browser-api.ts`. `params` is intentionally
 * open (`type: "object"`) — its shape varies per method and the desktop
 * client validates it.
 */

import { defineTool } from "../define.ts";

export const desktopBrowserTool = defineTool({
  id: "desktop_browser",
  name: "desktop_browser",
  description:
    "Drive the run owner's local Chromium browser through the Appstrate Desktop bridge — a companion app " +
    "running on the user's machine, with their own cookies and logged-in sessions. " +
    "Methods and their `params`: " +
    "`browser.navigate` {url} — load a URL (returns on dispatch, not on load completion); " +
    "`browser.click` {selector} — click the first match; " +
    "`browser.fill` {selector, value} — set an input's value (React/Vue-aware); " +
    "`browser.evaluate` {script} — run JavaScript in the page, returns the JSON-serialisable result; " +
    "`browser.screenshot` {} — PNG data URL of the visible page; " +
    "`browser.waitForSelector` {selector, timeoutMs?} — poll until the selector exists. " +
    "Returns 503 when no desktop is connected for this user. Prefer reading a page's own API " +
    "(extract its token via `browser.evaluate`, then call the REST endpoint) over clicking through pages. " +
    "Credential substitution: set `integrationId` (an integration declared by this agent) + " +
    "`substituteParams: true`, and every `{{field}}` placeholder inside `params` strings is replaced " +
    "server-side with the connected credential's field value AFTER your call leaves this context — " +
    "write `{{password}}`, never ask for the real value. You cannot read substituted values back: " +
    "every reply of this run is scrubbed of them.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["method"],
    properties: {
      method: {
        type: "string",
        enum: [
          "browser.navigate",
          "browser.click",
          "browser.fill",
          "browser.evaluate",
          "browser.screenshot",
          "browser.waitForSelector",
        ],
        description: "Browser primitive to invoke on the user's local Chromium.",
      },
      params: {
        type: "object",
        description:
          "Method-specific arguments — see the per-method shapes in this tool's description.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1000,
        maximum: 120000,
        description:
          "Optional per-command timeout the platform enforces on the desktop dispatch " +
          "(1s–120s, default 30s). Returns 504 if the desktop doesn't reply in time.",
      },
      integrationId: {
        type: "string",
        description:
          "Integration package id (`@scope/name`) whose connected credential fields fill " +
          "`{{field}}` placeholders in `params`. Must be declared in this agent's dependencies.",
      },
      substituteParams: {
        type: "boolean",
        description:
          "Enable server-side `{{field}}` substitution from `integrationId`'s connected " +
          "credentials. The real values never appear in your context.",
      },
    },
  },
});
