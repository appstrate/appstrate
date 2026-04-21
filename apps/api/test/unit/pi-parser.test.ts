// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parsePiStreamLine } from "../../src/services/adapters/pi.ts";

const RUN_ID = "run_test";

describe("parsePiStreamLine", () => {
  describe("usage event", () => {
    it("extracts token usage and cost", () => {
      const line = JSON.stringify({
        type: "usage",
        tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
        cost: 0.0034,
      });

      const msg = parsePiStreamLine(line, RUN_ID)!;
      expect(msg.type).toBe("appstrate.metric");
      expect(msg.usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 10,
      });
      expect(msg.cost).toBe(0.0034);
    });

    it("returns undefined cost when cost is not a number", () => {
      const line = JSON.stringify({
        type: "usage",
        tokens: { input: 100, output: 50 },
      });

      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg).not.toBeNull();
      expect(msg!.cost).toBeUndefined();
    });

    it("returns undefined cost when cost is null", () => {
      const line = JSON.stringify({
        type: "usage",
        tokens: { input: 100, output: 50 },
        cost: null,
      });

      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg!.cost).toBeUndefined();
    });

    it("handles zero cost", () => {
      const line = JSON.stringify({
        type: "usage",
        tokens: { input: 100, output: 50 },
        cost: 0,
      });

      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg!.cost).toBe(0);
    });

    it("defaults missing token fields to 0", () => {
      const line = JSON.stringify({ type: "usage", tokens: {}, cost: 0.001 });

      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg!.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
    });

    it("handles missing tokens object", () => {
      const line = JSON.stringify({ type: "usage", cost: 0.01 });

      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg!.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      expect(msg!.cost).toBe(0.01);
    });
  });

  describe("AFPS canonical events", () => {
    it("output → output.emitted with data", () => {
      const line = JSON.stringify({ type: "output", data: { count: 42, items: ["a"] } });
      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg!.type).toBe("output.emitted");
      expect(msg!.data).toEqual({ count: 42, items: ["a"] });
      expect(msg!.runId).toBe(RUN_ID);
    });

    it("set_state → state.set carries state under `state` key", () => {
      const line = JSON.stringify({ type: "set_state", state: { cursor: "abc" } });
      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg!.type).toBe("state.set");
      expect(msg!.state).toEqual({ cursor: "abc" });
    });

    it("add_memory → memory.added", () => {
      const line = JSON.stringify({ type: "add_memory", content: "Gmail paginates at 100" });
      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg!.type).toBe("memory.added");
      expect(msg!.content).toBe("Gmail paginates at 100");
    });

    it("report → report.appended", () => {
      const line = JSON.stringify({ type: "report", content: "work done" });
      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg!.type).toBe("report.appended");
      expect(msg!.content).toBe("work done");
    });

    it("assistant_message returns null (no JSON extraction)", () => {
      const line = JSON.stringify({
        type: "assistant_message",
        text: '```json\n{"summary":"test"}\n```',
      });
      expect(parsePiStreamLine(line, RUN_ID)).toBeNull();
    });
  });

  describe("platform events", () => {
    it("text_delta → appstrate.progress with message", () => {
      const line = JSON.stringify({ type: "text_delta", text: "hello" });
      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg!.type).toBe("appstrate.progress");
      expect(msg!.message).toBe("hello");
    });

    it("error → appstrate.error with message", () => {
      const line = JSON.stringify({ type: "error", message: "boom" });
      const msg = parsePiStreamLine(line, RUN_ID);
      expect(msg!.type).toBe("appstrate.error");
      expect(msg!.message).toBe("boom");
    });

    it("unknown type returns null", () => {
      const line = JSON.stringify({ type: "unknown_type" });
      expect(parsePiStreamLine(line, RUN_ID)).toBeNull();
    });

    it("invalid JSON returns appstrate.progress with bracketed raw content", () => {
      const msg = parsePiStreamLine("not json at all", RUN_ID);
      expect(msg!.type).toBe("appstrate.progress");
      expect(msg!.message).toBe("[container] not json at all");
    });

    it("empty line returns null", () => {
      expect(parsePiStreamLine("", RUN_ID)).toBeNull();
      expect(parsePiStreamLine("   ", RUN_ID)).toBeNull();
    });
  });
});
