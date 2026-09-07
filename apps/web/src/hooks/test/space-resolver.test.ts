// SPDX-License-Identifier: Apache-2.0

/**
 * A persisted space the caller can no longer enter has to be forgotten.
 * Auto-selection only ever SETS, so a stale id would keep riding on
 * `X-Space-Id` and 403 every space-scoped request while `usePermissions()`
 * reported itself ready — and when nothing is enterable at all there is no
 * default for auto-selection to replace it with.
 *
 * Asserted through `dropUnenterableSpace` rather than through
 * `useSpaceResolver`: this harness renders with `renderToStaticMarkup`, which
 * never runs the effect that calls it.
 */

import { describe, it, expect } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

// The space store writes through to `localStorage` on every set.
installFakeStorage();

const { spaceStore } = await import("../../stores/space-store.ts");
const { dropUnenterableSpace } = await import("../use-current-space.ts");

const enterable = [{ id: "spc_default" }, { id: "spc_marketing" }];

function resolveFrom(current: string | null, spaces: { id: string }[] | undefined) {
  spaceStore.getState().setId(current);
  dropUnenterableSpace(spaces, current);
  return spaceStore.getState().id;
}

describe("dropUnenterableSpace", () => {
  it("forgets a space the caller can no longer enter", () => {
    expect(resolveFrom("spc_closed", enterable)).toBeNull();
  });

  it("forgets it when NOTHING is enterable, where auto-selection has no default to pick", () => {
    expect(resolveFrom("spc_closed", [])).toBeNull();
  });

  it("keeps a space that is still enterable", () => {
    expect(resolveFrom("spc_marketing", enterable)).toBe("spc_marketing");
  });

  it("waits for the listing instead of clearing on an unanswered query", () => {
    expect(resolveFrom("spc_marketing", undefined)).toBe("spc_marketing");
  });
});
