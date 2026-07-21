// SPDX-License-Identifier: Apache-2.0

/**
 * Component schemas for the desktop module, merged into the platform
 * spec's `components.schemas` when the module is loaded.
 */

export const desktopSchemas = {
  DesktopCommandRequest: {
    type: "object",
    required: ["method"],
    description: "A browser primitive to execute on the user's local Appstrate Desktop client.",
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
        description: "Browser primitive to invoke.",
      },
      params: {
        type: "object",
        description: "Method-specific arguments (e.g. `{ url }`, `{ selector, value }`).",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1000,
        maximum: 120000,
        description: "Dispatch timeout in ms (1s-120s, default 30s). 504 when it elapses.",
      },
    },
  },
  DesktopAgentCommandRequest: {
    type: "object",
    required: ["method"],
    description:
      "Agent-path variant of DesktopCommandRequest: adds server-side credential substitution. " +
      "With `integrationId` + `substituteParams`, `{{field}}` placeholders inside `params` " +
      "strings are replaced by the run's connected credential fields for that integration " +
      "before dispatch — the values never appear in the agent's context, and every reply " +
      "for the run is scrubbed of them afterwards.",
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
        description: "Browser primitive to invoke.",
      },
      params: {
        type: "object",
        description:
          "Method-specific arguments. Strings may contain `{{field}}` placeholders when " +
          "substitution is enabled; unknown placeholders are left intact.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1000,
        maximum: 120000,
        description: "Dispatch timeout in ms (1s-120s, default 30s). 504 when it elapses.",
      },
      integrationId: {
        type: "string",
        description:
          "Integration package id (`@scope/name`) whose connected credential fields fill the " +
          "placeholders. Must be declared in the running agent's dependencies.",
      },
      substituteParams: {
        type: "boolean",
        description: "Enable `{{field}}` substitution from `integrationId`'s credentials.",
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
