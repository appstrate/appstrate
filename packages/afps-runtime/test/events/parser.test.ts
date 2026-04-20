// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { parseAfpsEventLine } from "../../src/events/parser.ts";

describe("parseAfpsEventLine", () => {
  it("parses add_memory", () => {
    const ev = parseAfpsEventLine('{"type":"add_memory","content":"hi"}');
    expect(ev).toEqual({ type: "add_memory", content: "hi" });
  });

  it("parses set_state with arbitrary payload", () => {
    const ev = parseAfpsEventLine('{"type":"set_state","state":{"n":1}}');
    expect(ev).toEqual({ type: "set_state", state: { n: 1 } });
  });

  it("parses output", () => {
    const ev = parseAfpsEventLine('{"type":"output","data":[1,2,3]}');
    expect(ev).toEqual({ type: "output", data: [1, 2, 3] });
  });

  it("parses report", () => {
    const ev = parseAfpsEventLine('{"type":"report","content":"## done"}');
    expect(ev).toEqual({ type: "report", content: "## done" });
  });

  it("parses log", () => {
    const ev = parseAfpsEventLine('{"type":"log","level":"info","message":"ok"}');
    expect(ev).toEqual({ type: "log", level: "info", message: "ok" });
  });

  it("ignores Pi SDK non-AFPS events (text_delta)", () => {
    const ev = parseAfpsEventLine('{"type":"text_delta","text":"streaming..."}');
    expect(ev).toBeNull();
  });

  it("ignores Pi SDK usage events", () => {
    const ev = parseAfpsEventLine(
      '{"type":"usage","tokens":{"input":100,"output":50},"cost":0.001}',
    );
    expect(ev).toBeNull();
  });

  it("ignores Pi SDK tool_start events", () => {
    const ev = parseAfpsEventLine('{"type":"tool_start","name":"fetch","args":{}}');
    expect(ev).toBeNull();
  });

  it("returns null on empty line", () => {
    expect(parseAfpsEventLine("")).toBeNull();
    expect(parseAfpsEventLine("   \n  ")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseAfpsEventLine("{not-json")).toBeNull();
    expect(parseAfpsEventLine("undefined")).toBeNull();
  });

  it("returns null on non-object JSON", () => {
    expect(parseAfpsEventLine('"a string"')).toBeNull();
    expect(parseAfpsEventLine("42")).toBeNull();
    expect(parseAfpsEventLine("null")).toBeNull();
    expect(parseAfpsEventLine("[1,2,3]")).toBeNull();
  });

  it("returns null on AFPS event with bad payload", () => {
    // add_memory with empty content
    expect(parseAfpsEventLine('{"type":"add_memory","content":""}')).toBeNull();
    // log with invalid level
    expect(parseAfpsEventLine('{"type":"log","level":"verbose","message":"x"}')).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    const ev = parseAfpsEventLine('   {"type":"add_memory","content":"x"}  ');
    expect(ev).toEqual({ type: "add_memory", content: "x" });
  });
});
