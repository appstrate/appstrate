// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parseSseFrames, parseSseJsonData } from "../src/sse.ts";

describe("parseSseFrames", () => {
  it("parses a complete event+data frame", () => {
    const { frames, buffer } = parseSseFrames('event: run_update\ndata: {"id":"1"}\n\n', "");
    expect(frames).toEqual([{ event: "run_update", data: '{"id":"1"}' }]);
    expect(buffer).toBe("");
  });

  it("parses multiple frames in one chunk", () => {
    const chunk = "event: a\ndata: 1\n\nevent: b\ndata: 2\n\n";
    const { frames, buffer } = parseSseFrames(chunk, "");
    expect(frames).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
    expect(buffer).toBe("");
  });

  it("keeps an incomplete trailing frame in the buffer across reads", () => {
    const first = parseSseFrames("event: run_update\nda", "");
    expect(first.frames).toEqual([]);
    expect(first.buffer).toBe("event: run_update\nda");

    const second = parseSseFrames("ta: payload\n\n", first.buffer);
    expect(second.frames).toEqual([{ event: "run_update", data: "payload" }]);
    expect(second.buffer).toBe("");
  });

  it("parses a data-only frame with empty event name", () => {
    const { frames } = parseSseFrames('data: {"x":1}\n\n', "");
    expect(frames).toEqual([{ event: "", data: '{"x":1}' }]);
  });

  it("joins multi-line data payloads with newline", () => {
    const { frames } = parseSseFrames("data: line1\ndata: line2\n\n", "");
    expect(frames).toEqual([{ event: "", data: "line1\nline2" }]);
  });

  it("strips trailing carriage returns (CRLF streams)", () => {
    const { frames } = parseSseFrames("event: a\r\ndata: 1\r\n\n", "");
    expect(frames).toEqual([{ event: "a", data: "1" }]);
  });

  it("ignores comment and unknown field lines", () => {
    const { frames } = parseSseFrames(": keep-alive\nid: 42\ndata: x\n\n", "");
    expect(frames).toEqual([{ event: "", data: "x" }]);
  });

  it("handles a frame split at the separator boundary", () => {
    const first = parseSseFrames("data: x\n", "");
    expect(first.frames).toEqual([]);
    const second = parseSseFrames("\ndata: y\n\n", first.buffer);
    expect(second.frames).toEqual([
      { event: "", data: "x" },
      { event: "", data: "y" },
    ]);
  });

  it("returns no frames for an empty chunk", () => {
    const { frames, buffer } = parseSseFrames("", "");
    expect(frames).toEqual([]);
    expect(buffer).toBe("");
  });
});

describe("parseSseJsonData", () => {
  it("parses a JSON payload", () => {
    expect(parseSseJsonData('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for the [DONE] sentinel", () => {
    expect(parseSseJsonData("[DONE]")).toBeNull();
  });

  it("returns null for an empty payload", () => {
    expect(parseSseJsonData("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseSseJsonData("{oops")).toBeNull();
  });

  it("parses non-object JSON payloads", () => {
    expect(parseSseJsonData("[1,2]")).toEqual([1, 2]);
    expect(parseSseJsonData('"str"')).toBe("str");
  });
});
