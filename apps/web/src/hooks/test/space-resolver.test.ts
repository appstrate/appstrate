// SPDX-License-Identifier: Apache-2.0

/**
 * A persisted space has to be forgotten when nothing is enterable any more:
 * auto-selection then has no default to replace it with, and the stale id
 * would keep 403-ing every space-scoped request. Asserted through
 * `dropUnenterableSpace` rather than `useSpaceResolver`: this harness renders
 * with `renderToStaticMarkup`, which never runs the effect that calls it.
 */

import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

// The space store writes through to `localStorage` on every set.
installFakeStorage();

const { spaceStore } = await import("../../stores/space-store.ts");
const { dropUnenterableSpace } = await import("../use-current-space.ts");

const enterable = [{ id: "spc_default" }, { id: "spc_marketing" }];

function resolveFrom(current: string | null, spaces: { id: string }[] | undefined) {
  const queryClient = new QueryClient();
  // A flat-keyed row from the current space; it must not outlive the space.
  queryClient.setQueryData(["runs", "list"], [{ id: "run_1" }]);
  spaceStore.getState().setId(current);
  dropUnenterableSpace(queryClient, spaces, current);
  return { id: spaceStore.getState().id, cached: queryClient.getQueryData(["runs", "list"]) };
}

describe("dropUnenterableSpace", () => {
  it("forgets the space, and its cached rows, when NOTHING is enterable", () => {
    expect(resolveFrom("spc_closed", [])).toEqual({ id: null, cached: undefined });
  });

  it("leaves a stale id to auto-selection when another space is enterable", () => {
    expect(resolveFrom("spc_closed", enterable).id).toBe("spc_closed");
  });

  it("keeps a space that is still enterable", () => {
    expect(resolveFrom("spc_marketing", enterable).id).toBe("spc_marketing");
  });

  it("waits for the listing instead of clearing on an unanswered query", () => {
    expect(resolveFrom("spc_marketing", undefined).id).toBe("spc_marketing");
  });
});
