// SPDX-License-Identifier: Apache-2.0

/**
 * Component schemas for the desktop module, merged into the platform
 * spec's `components.schemas` when the module is loaded.
 */

const directMethodProperty = {
  type: "string",
  enum: [
    "browser.navigate",
    "browser.click",
    "browser.fill",
    "browser.selectOption",
    "browser.evaluate",
    "browser.screenshot",
    "browser.waitForSelector",
  ],
  description: "Direct browser primitive available to the authenticated desktop owner.",
} as const;

const agentMethodProperty = {
  type: "string",
  enum: [
    ...directMethodProperty.enum,
    "browser.download",
    "browser.download_status",
    "browser.capture_credential",
    "browser.batch",
    "browser.tabs.open",
    "browser.tabs.close",
    "browser.tabs.list",
  ],
  description:
    "Agent browser primitive. `browser.tabs.open` {} opens a tab in the agent's own browser " +
    "profile and returns {tab_id}; `browser.tabs.close` {tab_id} and `browser.tabs.list` {} " +
    "manage them. Commands without `tab_id` act on the run's implicit tab, opened on first " +
    "use — an agent that never mentions tabs behaves exactly as before. " +
    "`browser.download` {url?|selector?, filename?, max_bytes?} " +
    "downloads a direct URL or atomically clicks a page control and returns {download_id, state}; " +
    "`browser.download_status` {download_id} reports " +
    "started/downloading/uploaded/failed with pct — both are answered by the platform, " +
    "the bytes travel desktop → storage over HTTPS, never over the control WebSocket. " +
    "`browser.selectOption` {selector, value?|label?} sets a native <select> (custom " +
    "div/listbox dropdowns are DOM — drive those with browser.click instead). " +
    "`browser.batch` {steps: [{method, params}, …]} runs up to 40 desktop-executable steps " +
    "in one round-trip with per-step credential substitution, stopping at the first failure.",
} as const;

const timeoutMsProperty = {
  type: "integer",
  minimum: 1000,
  maximum: 120000,
  description: "Dispatch timeout in ms (1s-120s, default 30s). 504 when it elapses.",
} as const;

export const desktopSchemas = {
  DesktopCommandRequest: {
    type: "object",
    required: ["method"],
    description: "A browser primitive to execute on the user's local Appstrate Desktop client.",
    properties: {
      method: directMethodProperty,
      params: {
        type: "object",
        description: "Method-specific arguments (e.g. `{ url }`, `{ selector, value }`).",
      },
      timeout_ms: timeoutMsProperty,
    },
  },
  DesktopAgentCommandRequest: {
    type: "object",
    required: ["method"],
    description:
      "Agent-path variant of DesktopCommandRequest: adds server-side credential substitution. " +
      "With `integration_id` + `substitute_params`, `{{field}}` placeholders inside `params` " +
      "strings are replaced by the run's connected credential fields for that integration " +
      "before dispatch — the values never appear in the agent's context, and every reply " +
      "for the run is scrubbed of them afterwards.",
    properties: {
      method: agentMethodProperty,
      params: {
        type: "object",
        description:
          "Method-specific arguments. Strings may contain `{{field}}` placeholders when " +
          "substitution is enabled; unknown placeholders are left intact.",
      },
      timeout_ms: timeoutMsProperty,
      integration_id: {
        type: "string",
        description:
          "Integration package id (`@scope/name`) whose connected credential fields fill the " +
          "placeholders. Must be declared in the running agent's dependencies.",
      },
      substitute_params: {
        type: "boolean",
        description: "Enable `{{field}}` substitution from `integration_id`'s credentials.",
      },
      tab_id: {
        type: "string",
        description:
          "Tab to drive, from `browser.tabs.open`. Omitted, the command uses the run's " +
          "implicit tab. 409 when another run owns it or the user took it over, 410 once closed.",
      },
    },
  },
  DesktopCommandResponse: {
    type: "object",
    required: ["result"],
    description: "The desktop client's reply, forwarded verbatim (scrubbed on the agent path).",
    properties: {
      result: {
        description:
          "Method-specific result — e.g. `{ url }` for navigate, `{ dataUrl }` for screenshot, " +
          "the evaluated value for evaluate.",
      },
    },
  },
  DesktopStatusResponse: {
    type: "object",
    required: ["connected"],
    description: "Whether the caller currently has a desktop companion connected.",
    properties: {
      connected: { type: "boolean" },
    },
  },
} as const;
