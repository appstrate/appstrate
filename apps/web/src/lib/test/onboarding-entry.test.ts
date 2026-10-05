// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { orgLessEntry } from "../onboarding-entry.ts";

describe("orgLessEntry", () => {
  it("sends a user who may create an organization to the creation form", () => {
    // Includes a platform admin on a closed instance: the server accepts them.
    expect(orgLessEntry(true)).toBe("/onboarding/create");
  });

  it("sends everyone else to the waiting page, never to a form the server refuses", () => {
    expect(orgLessEntry(false)).toBe("/onboarding/waiting");
  });
});
