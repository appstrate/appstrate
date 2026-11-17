// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mayCreateSpaceIn, settingsEntry, switcherShape } from "../switcher-context";

const HERE = { orgId: "org_here", spaceId: "spc_here" };

describe("the switcher's panel shape", () => {
  it("stacks one organization above its spaces, even beside the sidebar", () => {
    expect(switcherShape({ variant: "brand", isMobile: false, orgCount: 1 })).toEqual({
      mobilePresentation: false,
      stacked: true,
    });
  });

  it("puts several organizations beside their spaces on a wide screen", () => {
    expect(switcherShape({ variant: "brand", isMobile: false, orgCount: 2 })).toEqual({
      mobilePresentation: false,
      stacked: false,
    });
  });

  it("stacks on a phone, whatever the number of organizations", () => {
    for (const shape of [
      switcherShape({ variant: "mobile", isMobile: false, orgCount: 3 }),
      switcherShape({ variant: "brand", isMobile: true, orgCount: 3 }),
    ]) {
      expect(shape).toEqual({ mobilePresentation: true, stacked: true });
    }
  });
});

describe("how a row's settings open", () => {
  it("opens the current context's as a plain link", () => {
    expect(settingsEntry(HERE, { orgId: "org_here" })).toBe("link");
    expect(settingsEntry(HERE, { orgId: "org_here", spaceId: "spc_here" })).toBe("link");
  });

  it("enters another space of the organization first, the page staying beneath", () => {
    expect(settingsEntry(HERE, { orgId: "org_here", spaceId: "spc_other" })).toBe("space");
  });

  it("switches organization first for the gear of another organization or of its space", () => {
    expect(settingsEntry(HERE, { orgId: "org_other" })).toBe("organization");
    expect(settingsEntry(HERE, { orgId: "org_other", spaceId: "spc_there" })).toBe("organization");
  });

  it("switches to the explored organization for « Nouvel espace » there", () => {
    expect(settingsEntry(HERE, { orgId: "org_explored" })).toBe("organization");
  });

  it("enters a space even before one is current", () => {
    expect(
      settingsEntry({ orgId: "org_here", spaceId: null }, { orgId: "org_here", spaceId: "spc" }),
    ).toBe("space");
  });
});

describe("who may create a space", () => {
  const orgs = [
    { id: "org_here", permissions: ["spaces:read"] },
    { id: "org_explored", permissions: ["spaces:read", "spaces:write"] },
  ];

  it("reads the explored organization's own grant, the current one's included", () => {
    expect(mayCreateSpaceIn(orgs, "org_explored")).toBe(true);
    expect(mayCreateSpaceIn(orgs, "org_here")).toBe(false);
  });

  it("refuses an organization the listing does not hold", () => {
    expect(mayCreateSpaceIn(orgs, "org_gone")).toBe(false);
    expect(mayCreateSpaceIn(orgs, null)).toBe(false);
  });
});
