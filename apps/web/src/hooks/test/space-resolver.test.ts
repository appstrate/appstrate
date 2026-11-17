// SPDX-License-Identifier: Apache-2.0

/**
 * The remembered space becomes the request scope only through
 * `enterableSpaceId`: a space the caller can no longer enter (removed, closed,
 * absent from a persona's view) must never reach `X-Space-Id`. Asserted on the
 * pure selector rather than `useSpaceResolver`: this harness renders with
 * `renderToStaticMarkup`, which never runs the effect that applies it.
 */

import { describe, it, expect } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

// The space store reads `localStorage` at module init.
installFakeStorage();

const { droppedOnSpaceSwitch, enterableSpaceId } = await import("../use-current-space.ts");
const {
  ACROSS_SPACES,
  agentsKeys,
  packageKeys,
  paginatedRunsKeys,
  persistenceKeys,
  scheduleKeys,
  spansSpaces,
} = await import("../../lib/query-keys.ts");

const space = (id: string, access: string, isDefault = false, personal = false) => ({
  id,
  access,
  isDefault,
  personal,
});

const spaces = [
  space("spc_closed", "closed"),
  space("spc_default", "member", true),
  space("spc_marketing", "member"),
];

describe("enterableSpaceId", () => {
  it("restores the remembered space while it is still enterable", () => {
    expect(enterableSpaceId("spc_marketing", spaces)).toBe("spc_marketing");
  });

  it("falls back to the default when the remembered space is not enterable", () => {
    expect(enterableSpaceId("spc_closed", spaces)).toBe("spc_default");
    expect(enterableSpaceId("spc_deleted", spaces)).toBe("spc_default");
    expect(enterableSpaceId(null, spaces)).toBe("spc_default");
  });

  it("takes any enterable space when the default is not one", () => {
    const noDefault = [space("spc_default", "closed", true), space("spc_team", "member")];
    expect(enterableSpaceId("spc_default", noDefault)).toBe("spc_team");
  });

  it("scopes to no space when none is enterable", () => {
    expect(enterableSpaceId("spc_closed", [space("spc_closed", "closed", true)])).toBeNull();
    expect(enterableSpaceId("spc_default", [])).toBeNull();
  });

  it("lands a guest in the team space they were invited to, not in their empty personal space", () => {
    // A guest holds no role in the default space (not listed to them), and the
    // listing ranks the personal space before team spaces.
    const guest = [space("spc_mine", "member", false, true), space("spc_studio", "member")];
    expect(enterableSpaceId(null, guest)).toBe("spc_studio");
    expect(enterableSpaceId("spc_mine", guest)).toBe("spc_mine");
  });

  it("falls back to the personal space when it is the only one enterable", () => {
    const alone = [space("spc_mine", "member", false, true), space("spc_closed", "none")];
    expect(enterableSpaceId(null, alone)).toBe("spc_mine");
  });
});

describe("enterableSpaceId with a link naming a space (`?enterSpace=`)", () => {
  it("takes the linked space first while it is enterable, so a cold load scopes once", () => {
    expect(enterableSpaceId("spc_default", spaces, "spc_marketing")).toBe("spc_marketing");
  });

  it("keeps the remembered space when the linked one cannot be entered — not the default", () => {
    expect(enterableSpaceId("spc_marketing", spaces, "spc_closed")).toBe("spc_marketing");
    expect(enterableSpaceId("spc_marketing", spaces, "spc_deleted")).toBe("spc_marketing");
  });

  it("is unchanged without a link", () => {
    expect(enterableSpaceId("spc_marketing", spaces, null)).toBe("spc_marketing");
    expect(enterableSpaceId(null, spaces, null)).toBe("spc_default");
  });
});

describe("droppedOnSpaceSwitch", () => {
  const runs = (spanning = false) =>
    paginatedRunsKeys.list(
      "org_1",
      spanning ? ACROSS_SPACES : "spc_a",
      "/runs",
      null,
      null,
      null,
      false,
      "",
      15,
    );

  it("drops the current space's run, schedule, agent and package lists", () => {
    expect(droppedOnSpaceSwitch(runs())).toBe(true);
    expect(droppedOnSpaceSwitch(scheduleKeys.list("org_1", "spc_a"))).toBe(true);
    expect(droppedOnSpaceSwitch(agentsKeys.list("org_1", "spc_a"))).toBe(true);
    expect(droppedOnSpaceSwitch(packageKeys.list("skills", "org_1", "spc_a"))).toBe(true);
  });

  it("drops a run list of the current space whatever its search says", () => {
    const searched = paginatedRunsKeys.list(
      "org_1",
      "spc_a",
      "/runs",
      null,
      null,
      null,
      false,
      "across-spaces",
      15,
    );
    expect(droppedOnSpaceSwitch(searched)).toBe(true);
  });

  it("keeps the lists across spaces, which key no space", () => {
    expect(droppedOnSpaceSwitch(runs(true))).toBe(false);
    expect(droppedOnSpaceSwitch(scheduleKeys.list("org_1", ACROSS_SPACES))).toBe(false);
    expect(droppedOnSpaceSwitch(agentsKeys.list("org_1", ACROSS_SPACES))).toBe(false);
    expect(droppedOnSpaceSwitch(packageKeys.list("integrations", "org_1", ACROSS_SPACES))).toBe(
      false,
    );
  });

  // An agent's memories and schedules: the space sits at index 2 of both keys, the one
  // `spansSpaces` reads. A key whose space moves elsewhere would be kept on a switch and served
  // as the next space's rows.
  it("drops an agent's memories and schedules of the current space, keeps those across spaces", () => {
    const memories = (spaceId: string) =>
      persistenceKeys.list("org_1", spaceId, "member", "@acme/agent", { limit: 20 });
    const schedules = (spaceId: string) =>
      scheduleKeys.listForAgent("org_1", spaceId, "@acme/agent");

    expect(memories("spc_a")[2]).toBe("spc_a");
    expect(schedules("spc_a")[2]).toBe("spc_a");

    expect(spansSpaces(memories("spc_a"))).toBe(false);
    expect(spansSpaces(schedules("spc_a"))).toBe(false);
    expect(droppedOnSpaceSwitch(memories("spc_a"))).toBe(true);
    expect(droppedOnSpaceSwitch(schedules("spc_a"))).toBe(true);

    expect(spansSpaces(memories(ACROSS_SPACES))).toBe(true);
    expect(spansSpaces(schedules(ACROSS_SPACES))).toBe(true);
    expect(droppedOnSpaceSwitch(memories(ACROSS_SPACES))).toBe(false);
    expect(droppedOnSpaceSwitch(schedules(ACROSS_SPACES))).toBe(false);
  });

  it("reads the marker at the space's position only, not in a later segment", () => {
    // A package id or a scope tag spelling the marker is not a list across spaces.
    expect(
      droppedOnSpaceSwitch(
        persistenceKeys.list("org_1", "spc_a", ACROSS_SPACES, ACROSS_SPACES, null),
      ),
    ).toBe(true);
    expect(droppedOnSpaceSwitch(scheduleKeys.listForAgent("org_1", "spc_a", ACROSS_SPACES))).toBe(
      true,
    );
  });
});
