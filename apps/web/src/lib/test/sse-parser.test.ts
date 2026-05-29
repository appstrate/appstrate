// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parseSSEFrames } from "../sse-parser";

describe("parseSSEFrames", () => {
  it("parses a single complete frame", () => {
    const { frames, buffer } = parseSSEFrames('event: run_update\ndata: {"id":"1"}\n\n', "");
    expect(frames).toEqual([{ event: "run_update", data: '{"id":"1"}' }]);
    expect(buffer).toBe("");
  });

  it("parses multiple frames in one chunk", () => {
    const chunk = "event: run_update\ndata: a\n\n" + "event: connection_update\ndata: b\n\n";
    const { frames, buffer } = parseSSEFrames(chunk, "");
    expect(frames).toEqual([
      { event: "run_update", data: "a" },
      { event: "connection_update", data: "b" },
    ]);
    expect(buffer).toBe("");
  });

  it("carries an incomplete frame across two chunks", () => {
    const first = parseSSEFrames("event: run_update\nda", "");
    expect(first.frames).toEqual([]);
    expect(first.buffer).toBe("event: run_update\nda");

    const second = parseSSEFrames("ta: payload\n\n", first.buffer);
    expect(second.frames).toEqual([{ event: "run_update", data: "payload" }]);
    expect(second.buffer).toBe("");
  });

  it("keeps the last data line of a multi-line data frame", () => {
    const { frames, buffer } = parseSSEFrames(
      "event: run_update\ndata: line1\ndata: line2\n\n",
      "",
    );
    expect(frames).toEqual([{ event: "run_update", data: "line2" }]);
    expect(buffer).toBe("");
  });
});
