// SPDX-License-Identifier: Apache-2.0

/**
 * Which space-role presets the chat resource reaches.
 *
 * `chat:read` reaches `viewer` (a read-only preset that cannot open a
 * transcript is a preset with a hole) and `chat:write` stops one preset short
 * of it — at `runner`, whose whole point is launching agents through a friendly
 * surface without the authoring ones. That pairing is policy, not detail: a
 * preset added to the wrong half either hides the chat from a role that needs
 * it or hands a write surface to a role that must not have one.
 *
 * The platform asserts the same shape for the modules it owns
 * (`apps/api/test/unit/modules/module-loader.test.ts`); this half lives here
 * because the declaration does.
 */
import { describe, expect, it } from "bun:test";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import chatModule from "../src/index.ts";

/** The `presets` list declared for `chat:<action>`, at `level: "space"`. */
function presetsFor(action: string): readonly string[] {
  const entry = chatModule
    .permissionsContribution?.()
    .find(
      (contribution) =>
        contribution.resource === "chat" && contribution.actions.includes(action as never),
    );
  if (entry === undefined || entry.level !== "space") {
    throw new Error(`module-chat declares no space-level contribution for chat:${action}`);
  }
  return entry.presets;
}

describe("module-chat RBAC contribution", () => {
  it("reads reach every preset, writes stop at `runner`", () => {
    expect(presetsFor("read")).toEqual([...SPACE_ROLE_PRESETS]);
    expect(presetsFor("write")).toEqual(["admin", "builder", "operator", "runner"]);
  });

  it("names only presets the platform knows", () => {
    for (const action of ["read", "write"]) {
      for (const preset of presetsFor(action)) {
        expect(
          `chat:${action} names ${preset}: ${SPACE_ROLE_PRESETS.includes(preset as never)}`,
        ).toBe(`chat:${action} names ${preset}: true`);
      }
    }
  });
});
