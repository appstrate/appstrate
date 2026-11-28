// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  MAX_PRESENTED_ITEMS,
  readToolPresentation,
  TOOL_PRESENTATION_META_KEY,
  type PresentationSubject,
  type ToolPresentation,
} from "../src/mcp-presentation.ts";

describe("readToolPresentation", () => {
  const valid: ToolPresentation = { call: "search", count: 1, items: [] };

  it("reads the stamp under its key", () => {
    expect(readToolPresentation({ [TOOL_PRESENTATION_META_KEY]: valid })).toEqual(valid);
  });

  it("is undefined without a stamp, or with a malformed one", () => {
    expect(readToolPresentation(undefined)).toBeUndefined();
    expect(readToolPresentation({})).toBeUndefined();
    expect(
      readToolPresentation({ [TOOL_PRESENTATION_META_KEY]: { call: "search" } }),
    ).toBeUndefined();
    // No `call`: nothing guesses the variant.
    expect(
      readToolPresentation({ [TOOL_PRESENTATION_META_KEY]: { title: "Search" } }),
    ).toBeUndefined();
    expect(
      readToolPresentation({ [TOOL_PRESENTATION_META_KEY]: { call: "unheard_of" } }),
    ).toBeUndefined();
    expect(
      readToolPresentation({
        [TOOL_PRESENTATION_META_KEY]: {
          call: "caller",
          subject: { kind: "robot", id: "x" },
        },
      }),
    ).toBeUndefined();
  });

  it("bounds the subjects a search lists", () => {
    const items = Array.from({ length: MAX_PRESENTED_ITEMS + 1 }, (_, i) => ({
      kind: "agent" as const,
      id: `@a/${i}`,
    }));
    expect(
      readToolPresentation({ [TOOL_PRESENTATION_META_KEY]: { call: "search", count: 9, items } }),
    ).toBeUndefined();
  });

  it("reads each variant with its own fields only", () => {
    const subject: PresentationSubject = {
      kind: "integration",
      id: "@acme/gmail",
      icons: [{ src: "https://example.test/g.svg", mimeType: "image/svg+xml", theme: "light" }],
    };
    for (const presentation of [
      { call: "operation", tag: "Agents", method: "GET" },
      { call: "proxied_request", method: "GET", requests: 1, subject },
      { call: "remote_tool", title: "Search issues", subject },
      { call: "caller", subject: { kind: "user", id: "u1" } },
      valid,
    ] satisfies ToolPresentation[]) {
      expect(readToolPresentation({ [TOOL_PRESENTATION_META_KEY]: presentation })).toEqual(
        presentation,
      );
    }
    // A batch holds at least one request; a remote tool always has its title.
    for (const bad of [
      { call: "proxied_request", requests: 0, subject },
      { call: "remote_tool", subject },
    ]) {
      expect(readToolPresentation({ [TOOL_PRESENTATION_META_KEY]: bad })).toBeUndefined();
    }
  });
});
