// SPDX-License-Identifier: Apache-2.0

/**
 * Co-authoring is a role in a package's HOME space, not a stronger share
 * (#1440). These pin the four answers the share dialog's second tab renders —
 * above all the one no permission can change.
 */

import { describe, it, expect } from "bun:test";
import { coeditVerdict, type SpaceGrant } from "../package-permissions.ts";

function grant(overrides: Partial<SpaceGrant> = {}): SpaceGrant {
  return { permissions: [], personal: false, access: "member", ...overrides };
}

describe("coeditVerdict", () => {
  it("answers 'unknown' while the space list has not resolved", () => {
    expect(coeditVerdict(undefined)).toBe("unknown");
  });

  it("offers the invite when the home is a team space the caller administers", () => {
    expect(coeditVerdict(grant({ permissions: ["space-members:invite"] }))).toBe("invite");
  });

  it("refuses without the invite grant, whatever else the caller holds there", () => {
    expect(
      coeditVerdict(
        grant({ permissions: ["agents:write", "space-members:read", "space-settings:write"] }),
      ),
    ).toBe("no_authority");
  });

  // The invariant the whole tab exists to state: a personal space takes no
  // other member (`personal_space_has_no_members`) and is never converted while
  // it lives (`personal_space_not_orphaned`). A permission set that would say
  // "invite" on a team space must not say it here — the way out is to move the
  // package, and a UI that offered the invite would send the reader into a 409
  // no grant can clear.
  it("never offers the invite on a personal home, even holding the invite grant", () => {
    expect(coeditVerdict(grant({ personal: true, permissions: ["space-members:invite"] }))).toBe(
      "personal",
    );
  });

  it("answers 'personal' for the owner's own space, whose grant carries everything", () => {
    expect(
      coeditVerdict(
        grant({
          personal: true,
          permissions: ["space-members:invite", "space-members:change-role", "agents:write"],
        }),
      ),
    ).toBe("personal");
  });
});
