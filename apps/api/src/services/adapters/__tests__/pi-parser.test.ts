import { describe, test, expect } from "bun:test";
import { parsePiStreamLine } from "../pi.ts";

describe("parsePiStreamLine", () => {
  describe("usage event", () => {
    test("extracts token usage and cost", () => {
      const line = JSON.stringify({
        type: "usage",
        tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
        cost: 0.0034,
      });

      const msg = parsePiStreamLine(line);
      expect(msg).toEqual({
        type: "result",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 10,
        },
        cost: 0.0034,
      });
    });

    test("returns undefined cost when cost is not a number", () => {
      const line = JSON.stringify({
        type: "usage",
        tokens: { input: 100, output: 50 },
      });

      const msg = parsePiStreamLine(line);
      expect(msg).toBeDefined();
      expect(msg!.cost).toBeUndefined();
    });

    test("returns undefined cost when cost is null", () => {
      const line = JSON.stringify({
        type: "usage",
        tokens: { input: 100, output: 50 },
        cost: null,
      });

      const msg = parsePiStreamLine(line);
      expect(msg!.cost).toBeUndefined();
    });

    test("handles zero cost", () => {
      const line = JSON.stringify({
        type: "usage",
        tokens: { input: 100, output: 50 },
        cost: 0,
      });

      const msg = parsePiStreamLine(line);
      expect(msg!.cost).toBe(0);
    });

    test("defaults missing token fields to 0", () => {
      const line = JSON.stringify({ type: "usage", tokens: {}, cost: 0.001 });

      const msg = parsePiStreamLine(line);
      expect(msg!.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
    });

    test("handles missing tokens object", () => {
      const line = JSON.stringify({ type: "usage", cost: 0.01 });

      const msg = parsePiStreamLine(line);
      expect(msg!.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      expect(msg!.cost).toBe(0.01);
    });
  });

  describe("other event types", () => {
    test("text_delta returns progress message", () => {
      const line = JSON.stringify({ type: "text_delta", text: "hello" });
      const msg = parsePiStreamLine(line);
      expect(msg).toEqual({ type: "progress", message: "hello" });
    });

    test("error returns error message", () => {
      const line = JSON.stringify({ type: "error", message: "boom" });
      const msg = parsePiStreamLine(line);
      expect(msg).toEqual({ type: "error", message: "boom" });
    });

    test("unknown type returns null", () => {
      const line = JSON.stringify({ type: "unknown_type" });
      expect(parsePiStreamLine(line)).toBeNull();
    });

    test("invalid JSON returns progress with raw content", () => {
      const msg = parsePiStreamLine("not json at all");
      expect(msg).toEqual({ type: "progress", message: "[container] not json at all" });
    });

    test("empty line returns null", () => {
      expect(parsePiStreamLine("")).toBeNull();
      expect(parsePiStreamLine("   ")).toBeNull();
    });
  });
});
