// SPDX-License-Identifier: Apache-2.0

/**
 * A member's catalogue waits on the space listing. A listing that failed must
 * surface as the catalogue's error — not an endless spinner with `error: null`
 * — and a listing that is not read at all is not loading.
 */

import { describe, expect, it } from "bun:test";
import { combineSpaceLibraries } from "../use-library.ts";

const emptyLibrary = {
  spaces: [],
  packages: { agent: [], skill: [], "mcp-server": [], integration: [] },
};

describe("combineSpaceLibraries", () => {
  it("carries the space listing's failure and stops loading", () => {
    const failure = new Error("boom");
    expect(
      combineSpaceLibraries({ data: undefined, isLoading: false, error: failure }, []),
    ).toEqual({ data: undefined, isLoading: false, error: failure });
  });

  it("loads while the space listing is in flight", () => {
    expect(combineSpaceLibraries({ data: undefined, isLoading: true, error: null }, [])).toEqual({
      data: undefined,
      isLoading: true,
      error: null,
    });
  });

  it("is idle, not loading, when the listing is disabled", () => {
    expect(
      combineSpaceLibraries({ data: undefined, isLoading: false, error: null }, []).isLoading,
    ).toBe(false);
  });

  it("loads while a space's library is in flight", () => {
    const result = combineSpaceLibraries({ data: [], isLoading: false, error: null }, [
      { data: undefined, isLoading: true, error: null },
    ]);
    expect(result).toEqual({ data: undefined, isLoading: true, error: null });
  });

  it("carries a space library's failure", () => {
    const failure = new Error("403");
    const result = combineSpaceLibraries({ data: [], isLoading: false, error: null }, [
      { data: emptyLibrary, isLoading: false, error: null },
      { data: undefined, isLoading: false, error: failure },
    ]);
    expect(result.error).toBe(failure);
    expect(result.data).toBeUndefined();
  });

  it("merges every space's library once all have answered", () => {
    const result = combineSpaceLibraries({ data: [], isLoading: false, error: null }, [
      { data: emptyLibrary, isLoading: false, error: null },
    ]);
    expect(result.isLoading).toBe(false);
    expect(result.error).toBeNull();
    expect(result.data?.packages.agent).toEqual([]);
  });
});
