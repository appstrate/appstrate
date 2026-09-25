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

const { enterableSpaceId } = await import("../use-current-space.ts");

const space = (id: string, access: string, isDefault = false) => ({ id, access, isDefault });

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
});
