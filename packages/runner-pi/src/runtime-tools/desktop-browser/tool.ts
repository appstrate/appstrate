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
    "`browser.navigate` {url, timeoutMs?} — load a URL and wait for the page load event (returns {loaded:false} instead of hanging when a long-polling page never fires it); " +
    "`browser.click` {selector} — click the first match; " +
    "`browser.fill` {selector, value} — set an input's value (React/Vue-aware); " +
    "`browser.evaluate` {script} — run JavaScript in the page (promises awaited); a thrown " +
    "exception comes back with its description and line number; " +
    "`browser.screenshot` {fullPage?, format?, quality?} — data URL capture, full scrollable page when fullPage; " +
    "`browser.waitForSelector` {selector, timeoutMs?} — poll until the selector exists; " +
    "`browser.download` {url, filename?} — download a file with the page's own session " +
    "(returns {download_id}: poll `browser.download_status` {download_id} until `uploaded`, " +
    "then call the `desktop_download` tool to land it in the workspace). " +
    "`browser.capture_credential` {integration_id, auth_key, script} — after logging into a " +
    "site, run `script` in the page to read its session token (or any secret) and store it " +
    "into the named integration credential, WRITE-ONLY: the value goes straight to the " +
    "platform credential store (you get back only {captured, fields}), and the rest of the " +
    "run then reaches the site's API through that integration's `api_call` tool with the " +
    "token injected server-side — never read tokens into your own context. " +
    "`browser.batch` {steps: [{method, params}, …]} — run up to 40 steps in ONE round-trip, " +
    "stopping at the first failure (result: {completed, results[], error?}); use it to TEST a " +
    "sequence while analyzing a site, then freeze it into a skill file and call the " +
    "`desktop_batch` tool instead. " +
    "Returns 503 when no desktop is connected for this user. Prefer reading a page's own API " +
    "(extract its token via `browser.evaluate`, then call the REST endpoint) over clicking through pages. " +
    "Credential substitution: set `integration_id` (an integration declared by this agent) + " +
    "`substitute_params: true`, and every `{{field}}` placeholder inside `params` strings is replaced " +
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
          "browser.download",
          "browser.download_status",
          "browser.capture_credential",
          "browser.batch",
        ],
        description: "Browser primitive to invoke on the user's local Chromium.",
      },
      params: {
        type: "object",
        description:
          "Method-specific arguments — see the per-method shapes in this tool's description.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        maximum: 120000,
        description:
          "Optional per-command timeout the platform enforces on the desktop dispatch " +
          "(1s–120s, default 30s). Returns 504 if the desktop doesn't reply in time.",
      },
      integration_id: {
        type: "string",
        description:
          "Integration package id (`@scope/name`) whose connected credential fields fill " +
          "`{{field}}` placeholders in `params`. Must be declared in this agent's dependencies.",
      },
      substitute_params: {
        type: "boolean",
        description:
          "Enable server-side `{{field}}` substitution from `integration_id`'s connected " +
          "credentials. The real values never appear in your context.",
      },
    },
  },
});
