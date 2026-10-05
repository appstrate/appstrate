// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createStepRedirect, orgLessEntry } from "../onboarding-entry.ts";

describe("orgLessEntry", () => {
  it("sends a user who may create an organization to the creation form", () => {
    // Includes a platform admin on a closed instance: the server accepts them.
    expect(orgLessEntry(true)).toBe("/onboarding/create");
  });

  it("sends everyone else to the waiting page, never to a form the server refuses", () => {
    expect(orgLessEntry(false)).toBe("/onboarding/waiting");
  });
});

describe("createStepRedirect", () => {
  const closed = { canCreateOrg: false };

  it("leaves the form to a user who may create, wherever they come from", () => {
    expect(
      createStepRedirect({ canCreateOrg: true, hasOrg: false, fromSwitcher: false }),
    ).toBeNull();
    expect(createStepRedirect({ canCreateOrg: true, hasOrg: true, fromSwitcher: true })).toBeNull();
  });

  it("turns away an org-less user who may not create", () => {
    expect(createStepRedirect({ ...closed, hasOrg: false, fromSwitcher: false })).toBe(
      "/onboarding/waiting",
    );
  });

  it("turns away a member asking the switcher for another organization", () => {
    expect(createStepRedirect({ ...closed, hasOrg: true, fromSwitcher: true })).toBe("/");
  });

  it("does not pre-empt the onboarding of an existing organization", () => {
    // The bootstrap owner of a closed instance: has the org, may not create
    // another, and must still be moved on to the model step by the page.
    expect(createStepRedirect({ ...closed, hasOrg: true, fromSwitcher: false })).toBeNull();
  });
});
