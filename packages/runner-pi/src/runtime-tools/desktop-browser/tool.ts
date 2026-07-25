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

const EVALUATE_METHOD_DESCRIPTION =
  "`browser.evaluate` {script} — run JavaScript in the page (promises awaited); a thrown " +
  "exception comes back with its description and line number; ";

export const desktopBrowserTool = defineTool({
  id: "desktop_browser",
  name: "desktop_browser",
  description:
    "Drive the run owner's local Chromium browser through the Appstrate Desktop bridge — a companion app " +
    "running on the user's machine, with their own cookies and logged-in sessions. " +
    "Methods and their `params`: " +
    "`browser.navigate` {url, timeoutMs?} — load a URL and wait for the page load event (returns {loaded:false} instead of hanging when a long-polling page never fires it); " +
    "`browser.click` {selector} — native trusted click on the first match; " +
    "`browser.fill` {selector, value} — native keystroke input into a field (focus + type, real trusted events); " +
    "`browser.selectOption` {selector, value?|label?} — set a native <select> dropdown by option value or visible text (for custom div/listbox dropdowns, use browser.click to open then click the option); " +
    EVALUATE_METHOD_DESCRIPTION +
    "`browser.screenshot` {fullPage?, format?, quality?} — data URL capture, full scrollable page when fullPage; " +
    "`browser.waitForSelector` {selector, timeoutMs?} — poll until the selector exists; " +
    "`browser.download` {url?, selector?, filename?} — download a direct URL, or atomically " +
    "click a page control identified by selector, with the page's own session " +
    "(returns {download_id}: poll `browser.download_status` {download_id} until `uploaded`, " +
    "then call the `desktop_download` tool to land it in the workspace). " +
    "`browser.capture_credential` {integration_id, auth_key, fields} — after logging into a " +
    "site, read named credential fields from declarative browser storage sources. Each field is " +
    '`{source: "local_storage"|"session_storage"|"cookie", key, json_path?}`. Store it ' +
    "into the named integration credential, WRITE-ONLY: the value goes straight to the " +
    "platform credential store (you get back only {captured, fields}), and the rest of the " +
    "run then reaches the site's API through that integration's `api_call` tool with the " +
    "token injected server-side — never read tokens into your own context. " +
    "`browser.batch` {steps: [{method, params}, …]} — run up to 40 steps in ONE round-trip, " +
    "stopping at the first failure (result: {completed, results[], error?}); use it to TEST a " +
    "sequence while analyzing a site, then freeze it into a skill file and call the " +
    "`desktop_batch` tool instead. " +
    "Tabs: you work in your own browser profile, separate from the user's and from other " +
    "agents'. Commands without `tab_id` all act on one implicit tab, which is enough for most " +
    "jobs. Open more only when you genuinely need two pages at once (waiting on a code in a " +
    "webmail while a form stays open): `browser.tabs.open` {} returns {tab_id} to pass as the " +
    "top-level `tab_id` of later commands, `browser.tabs.list` {} shows yours, " +
    "`browser.tabs.close` {tab_id} releases one. Up to 3 at a time; they all close when the run " +
    "ends. 409 means another run holds that surface or the user took the tab over (they are " +
    "clearing a login or a challenge — wait and retry); 410 means the tab is gone, open a new one. " +
    "Returns 503 when no desktop is connected for this user. Use " +
    "`browser.capture_credential` followed by the integration's credential-injecting `api_call` " +
    "instead of reading tokens into your context. " +
    "Credential substitution: set `integration_id` (an integration declared by this agent) + " +
    "`substitute_params: true`, and every `{{field}}` placeholder inside `params` strings is replaced " +
    "server-side with the connected credential's field value AFTER your call leaves this context — " +
    "write `{{password}}`, never ask for the real value. Substitution is accepted only by " +
    "`browser.fill`; arbitrary scripts never receive credential values. Replies are scrubbed " +
    "as defence in depth.",
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
          "browser.selectOption",
          "browser.evaluate",
          "browser.screenshot",
          "browser.waitForSelector",
          "browser.download",
          "browser.download_status",
          "browser.capture_credential",
          "browser.batch",
          "browser.tabs.open",
          "browser.tabs.close",
          "browser.tabs.list",
        ],
        description: "Browser primitive to invoke on the user's local Chromium.",
      },
      tab_id: {
        type: "string",
        description:
          "Tab returned by `browser.tabs.open`. Omit it to use your implicit tab — that is " +
          "the right default unless you deliberately keep several pages open at once.",
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

const desktopProperties = desktopBrowserTool.parameters.properties as Record<string, unknown>;
const desktopMethod = desktopProperties.method as {
  enum: readonly string[];
  [key: string]: unknown;
};

/** Agent-facing contract for the safer base capability, without arbitrary page JavaScript. */
export const desktopBrowserToolWithoutEvaluate = defineTool({
  ...desktopBrowserTool,
  description: desktopBrowserTool.description.replace(EVALUATE_METHOD_DESCRIPTION, ""),
  parameters: {
    ...desktopBrowserTool.parameters,
    properties: {
      ...desktopProperties,
      method: {
        ...desktopMethod,
        enum: desktopMethod.enum.filter((method) => method !== "browser.evaluate"),
      },
    },
  },
});
