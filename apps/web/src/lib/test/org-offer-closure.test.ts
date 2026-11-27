// SPDX-License-Identifier: Apache-2.0

/**
 * The dialog an offered agent raises: the integrations its warnings name, shown by the library's
 * display name when the caller sees the package.
 */

import { describe, it, expect } from "bun:test";
import { offerClosureEntries } from "../org-offer-closure.ts";

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
