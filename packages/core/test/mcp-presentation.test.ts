// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  MAX_PRESENTED_ITEMS,
  readToolPresentation,
  TOOL_PRESENTATION_META_KEY,
} from "../src/mcp-presentation.ts";

describe("readToolPresentation", () => {
  const valid = { title: "Search" };

  it("reads the stamp under its key", () => {
    expect(readToolPresentation({ [TOOL_PRESENTATION_META_KEY]: valid })).toEqual(valid);
  });

  it("is undefined without a stamp, or with a malformed one", () => {
    expect(readToolPresentation(undefined)).toBeUndefined();
    expect(readToolPresentation({})).toBeUndefined();
    expect(readToolPresentation({ [TOOL_PRESENTATION_META_KEY]: { title: "" } })).toBeUndefined();
    expect(
      readToolPresentation({
        [TOOL_PRESENTATION_META_KEY]: { ...valid, subject: { kind: "robot", id: "x" } },
      }),
    ).toBeUndefined();
  });

  it("reads no subject of a kind it does not know", () => {
    expect(
      readToolPresentation({
        [TOOL_PRESENTATION_META_KEY]: { ...valid, subject: { kind: "package", id: "@a/b" } },
      }),
    ).toBeUndefined();
  });

  it("bounds the subjects a search lists", () => {
    const items = Array.from({ length: MAX_PRESENTED_ITEMS + 1 }, (_, i) => ({
      kind: "agent" as const,
      id: `@a/${i}`,
    }));
    expect(
      readToolPresentation({ [TOOL_PRESENTATION_META_KEY]: { ...valid, items } }),
    ).toBeUndefined();
  });
});
