// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import {
  isRunDegraded,
  parseUnavailableTools,
  UNAVAILABLE_REASON_KEYS,
  unavailableReasonKey,
} from "../run-degradation.ts";

await i18nReady;
await i18n.changeLanguage("fr");

describe("unavailableReasonKey", () => {
  it("names a label for every reason the platform stamps, blocked_in_space included", () => {
    expect(Object.keys(UNAVAILABLE_REASON_KEYS)).toContain("blocked_in_space");
    for (const key of [...Object.values(UNAVAILABLE_REASON_KEYS), unavailableReasonKey(null)]) {
      expect(i18n.exists(key, { ns: "agents" })).toBe(true);
    }
    expect(i18n.t(unavailableReasonKey("blocked_in_space"), { ns: "agents" })).toBe(
      "Bloqué dans cet espace",
    );
  });
});

describe("parseUnavailableTools", () => {
  it("reads the stamped entries", () => {
    expect(
      parseUnavailableTools({
        unavailable_tools: [{ integration_id: "@acme/gmail", name: "send", reason: "not_listed" }],
      }),
    ).toEqual([{ integrationId: "@acme/gmail", name: "send", reason: "not_listed" }]);
  });

  it("drops malformed entries and non-object metadata", () => {
    expect(parseUnavailableTools(null)).toEqual([]);
    expect(parseUnavailableTools({ unavailable_tools: "x" })).toEqual([]);
    expect(
      parseUnavailableTools({
        unavailable_tools: [null, { name: "a" }, { integration_id: "i", name: "b" }],
      }),
    ).toEqual([{ integrationId: "i", name: "b", reason: null }]);
  });

  it("narrows the reason to the platform's, and keeps an unknown one as null", () => {
    const reasons = parseUnavailableTools({
      unavailable_tools: [
        { integration_id: "i", name: "a", reason: "definition_not_approved" },
        { integration_id: "i", name: "b", reason: "from_the_future" },
        { integration_id: "i", name: "c", reason: "toString" },
      ],
    }).map((tool) => tool.reason);
    expect(reasons).toEqual(["definition_not_approved", null, null]);
  });
});

describe("isRunDegraded", () => {
  it("is true for either warning and false otherwise", () => {
    expect(isRunDegraded({ degraded_integrations: ["@a/b"] })).toBe(true);
    expect(
      isRunDegraded({ unavailable_tools: [{ integration_id: "i", name: "n", reason: "r" }] }),
    ).toBe(true);
    expect(isRunDegraded({ degraded_integrations: [] })).toBe(false);
  });
});
