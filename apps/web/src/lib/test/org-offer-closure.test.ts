// SPDX-License-Identifier: Apache-2.0

/**
 * The dialog an offered agent raises: the integrations its warnings name, shown by the library's
 * display name when the caller sees the package, and offered one request each in the agent's mode.
 */

import { describe, it, expect } from "bun:test";
import { offerClosureEntries, offerClosureRequests } from "../org-offer-closure.ts";

describe("offerClosureEntries", () => {
  it("reads the integration id from the warning's field and keeps the required flag", () => {
    const entries = offerClosureEntries(
      [
        { field: "integrations.@acme/slack", required: true },
        { field: "integrations.@acme/gmail", required: false },
      ],
      [{ id: "@acme/slack", name: "Slack" }],
    );
    expect(entries).toEqual([
      { id: "@acme/slack", name: "Slack", required: true },
      { id: "@acme/gmail", name: "@acme/gmail", required: false },
    ]);
  });
});

describe("offerClosureRequests", () => {
  it("builds one offer per integration, in the agent's mode", () => {
    const entries = [
      { id: "@acme/slack", name: "Slack", required: true },
      { id: "@acme/gmail", name: "Gmail", required: false },
    ];
    expect(offerClosureRequests(entries, "on_by_default")).toEqual([
      { packageId: "@acme/slack", mode: "on_by_default" },
      { packageId: "@acme/gmail", mode: "on_by_default" },
    ]);
    expect(offerClosureRequests([], "available")).toEqual([]);
  });
});
