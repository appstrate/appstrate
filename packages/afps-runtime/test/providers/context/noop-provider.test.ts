// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { NoopContextProvider } from "../../../src/providers/context/noop-provider.ts";

describe("NoopContextProvider", () => {
  const provider = new NoopContextProvider();

  it("returns an empty memories array", async () => {
    expect(await provider.getMemories()).toEqual([]);
    expect(await provider.getMemories({ limit: 10 })).toEqual([]);
  });

  it("returns an empty history array", async () => {
    expect(await provider.getHistory()).toEqual([]);
  });

  it("returns null for state", async () => {
    expect(await provider.getState()).toBeNull();
  });

  it("returns undefined for any resource", async () => {
    expect(await provider.getResource!("file:///anything")).toBeUndefined();
  });
});
