import { describe, test, expect } from "bun:test";
import { extractJsonResult } from "../adapters/prompt-builder.ts";

describe("extractJsonResult", () => {
  test("extracts from standard ```json fence", () => {
    const text = 'Here is the result:\n```json\n{"summary": "done"}\n```';
    const result = extractJsonResult(text);
    expect(result).toEqual({ summary: "done" });
  });

  test("extracts last ```json fence when multiple exist", () => {
    const text =
      '```json\n{"summary": "first"}\n```\nSome text\n```json\n{"summary": "second"}\n```';
    const result = extractJsonResult(text);
    expect(result).toEqual({ summary: "second" });
  });

  test("extracts from ```JSON (uppercase) fence", () => {
    const text = 'Result:\n```JSON\n{"summary": "upper"}\n```';
    const result = extractJsonResult(text);
    expect(result).toEqual({ summary: "upper" });
  });

  test("extracts from ```Json (mixed case) fence", () => {
    const text = 'Result:\n```Json\n{"summary": "mixed"}\n```';
    const result = extractJsonResult(text);
    expect(result).toEqual({ summary: "mixed" });
  });

  test("extracts JSON from bare ``` fence", () => {
    const text = 'Here:\n```\n{"summary": "bare"}\n```';
    const result = extractJsonResult(text);
    expect(result).toEqual({ summary: "bare" });
  });

  test("ignores bare ``` fence with non-JSON content", () => {
    const text = "```\nsome plain text\n```";
    const result = extractJsonResult(text);
    expect(result).toBeNull();
  });

  test("extracts raw JSON without any fence", () => {
    const text = 'The result is: {"summary": "raw", "count": 3}';
    const result = extractJsonResult(text);
    expect(result).toEqual({ summary: "raw", count: 3 });
  });

  test("prefers ```json fence over bare fence and raw JSON", () => {
    const text =
      '{"summary": "raw"}\n```\n{"summary": "bare"}\n```\n```json\n{"summary": "fenced"}\n```';
    const result = extractJsonResult(text);
    expect(result).toEqual({ summary: "fenced" });
  });

  test("falls back to bare fence when ```json has invalid JSON", () => {
    const text =
      '```json\n{invalid json}\n```\n\nHere is the corrected result:\n```\n{"summary": "fallback"}\n```';
    const result = extractJsonResult(text);
    expect(result).toEqual({ summary: "fallback" });
  });

  test("falls back to raw JSON when all fences have invalid content", () => {
    const text =
      '```json\n{bad}\n```\nSome text\n```\nnot json\n```\nResult: {"summary": "last resort"}';
    const result = extractJsonResult(text);
    expect(result).toEqual({ summary: "last resort" });
  });

  test("returns null for completely non-JSON text", () => {
    const text = "This is just plain text without any JSON.";
    const result = extractJsonResult(text);
    expect(result).toBeNull();
  });

  test("returns null for malformed JSON everywhere", () => {
    const text = "```json\n{broken\n```\n```\n{also broken\n```\n{still broken";
    const result = extractJsonResult(text);
    expect(result).toBeNull();
  });

  test("handles multiline JSON in fence", () => {
    const text = '```json\n{\n  "summary": "multiline",\n  "items": [1, 2, 3]\n}\n```';
    const result = extractJsonResult(text);
    expect(result).toEqual({ summary: "multiline", items: [1, 2, 3] });
  });

  test("does not match arrays as raw JSON (must be object)", () => {
    const text = "[1, 2, 3]";
    const result = extractJsonResult(text);
    expect(result).toBeNull();
  });
});
