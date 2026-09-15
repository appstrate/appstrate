// SPDX-License-Identifier: Apache-2.0

/**
 * The verdict every launch control asks before it greys itself out.
 *
 * It has THREE answers, and the third is the load-bearing one. The space
 * library lists, per family, only what the caller may READ of that family, and
 * those permission sets do not line up with the run gate: a `runner` holds
 * `agents:run` and no `agents:read` (`RUNNER_PRESET_PERMISSIONS`), so the
 * payload comes back with no agents in it for exactly the caller most likely to
 * be looking at a Run button. Reading that silence as "not active here" kills a
 * control the server would have accepted — so absence is `undefined`, and only
 * a package the payload CARRIES can be called inactive.
 */

import { describe, expect, it } from "bun:test";
import { activationStateOf } from "../use-library.ts";
import type { LibraryPackageItem, LibraryPlacement, LibraryResponse } from "../use-library.ts";

const SPACE = "spc_here";

function placement(state: LibraryPlacement["state"]): LibraryPlacement {
  return { space_id: SPACE, via: "home", state, shared_by: null };
}

function libraryWith(agents: LibraryPackageItem[]): Pick<LibraryResponse, "packages"> {
  return { packages: { agent: agents, skill: [], "mcp-server": [], integration: [] } };
}

function agentRow(placements: LibraryPlacement[]): LibraryPackageItem {
  return {
    id: "@acme/worker",
    name: "Worker",
    description: "",
    type: "agent",
    source: "local",
    home_space_id: SPACE,
    home_writable: false,
    home_shareable: false,
    placements,
  };
}

describe("a package the library carries", () => {
  it("is active when its placement here says so", () => {
    expect(
      activationStateOf(libraryWith([agentRow([placement("active")])]), "@acme/worker", SPACE),
    ).toEqual({ isActiveInCurrentSpace: true, placement: placement("active") });
  });

  it("is inactive when the placement is switched off", () => {
    expect(
      activationStateOf(libraryWith([agentRow([placement("inactive")])]), "@acme/worker", SPACE)
        .isActiveInCurrentSpace,
    ).toBe(false);
  });

  it("is inactive when it is placed here with no local instance at all", () => {
    // An untaken offer: listed, never switched on, and the run gate refuses it.
    expect(
      activationStateOf(libraryWith([agentRow([placement("none")])]), "@acme/worker", SPACE)
        .isActiveInCurrentSpace,
    ).toBe(false);
  });
});

describe("a package the library does NOT carry", () => {
  it("answers `undefined`, not `false`, so no control blames the caller", () => {
    // What a `runner` gets: the route answered, with no agent in it, because
    // `agents:read` is not theirs. Saying "inactive" here would grey out the
    // Run button of an agent they are perfectly entitled to launch.
    const verdict = activationStateOf(libraryWith([]), "@acme/worker", SPACE);
    expect(verdict.isActiveInCurrentSpace).toBeUndefined();
    expect(verdict.placement).toBeUndefined();
  });

  it("answers `undefined` while the route has not answered yet", () => {
    expect(
      activationStateOf(undefined, "@acme/worker", SPACE).isActiveInCurrentSpace,
    ).toBeUndefined();
  });

  it("CONTROL: a row present but placed in ANOTHER space reads as inactive", () => {
    // The package IS readable — the payload names it — and it simply does not
    // run in the space the caller stands in. That is a real `false`, and the
    // rule above must not swallow it.
    expect(
      activationStateOf(
        libraryWith([agentRow([{ ...placement("active"), space_id: "spc_elsewhere" }])]),
        "@acme/worker",
        SPACE,
      ).isActiveInCurrentSpace,
    ).toBe(false);
  });
});
