import { describe, test, expect, mock } from "bun:test";
import { Hono } from "hono";
import type { ParsedInput } from "../input-parser.ts";

// --- Mocks ---

mock.module("../schema.ts", () => ({
  validateInput: () => ({ valid: true, errors: [] }),
  validateFileInputs: () => ({ valid: true, errors: [] }),
  schemaHasFileFields: () => false,
  parseFormDataFiles: async () => ({ input: undefined, files: [] }),
}));

const { parseRequestInput } = await import("../input-parser.ts");

// --- Helpers ---

interface ParseResult {
  ok: boolean;
  data: ParsedInput;
}

function jsonApp(body: unknown) {
  const app = new Hono();
  app.post("/", async (c) => {
    const result = await parseRequestInput(c);
    return c.json(result);
  });
  return app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- Tests ---

describe("parseRequestInput", () => {
  test("parses modelId and proxyId from JSON body", async () => {
    const res = await jsonApp({
      input: { text: "hello" },
      modelId: "model-abc",
      proxyId: "proxy-def",
    });
    const json = (await res.json()) as ParseResult;

    expect(json.ok).toBe(true);
    expect(json.data.input).toEqual({ text: "hello" });
    expect(json.data.modelId).toBe("model-abc");
    expect(json.data.proxyId).toBe("proxy-def");
  });

  test("modelId and proxyId are undefined when not provided", async () => {
    const res = await jsonApp({ input: { text: "hello" } });
    const json = (await res.json()) as ParseResult;

    expect(json.ok).toBe(true);
    expect(json.data.modelId).toBeUndefined();
    expect(json.data.proxyId).toBeUndefined();
  });

  test("works with empty body", async () => {
    const res = await jsonApp({});
    const json = (await res.json()) as ParseResult;

    expect(json.ok).toBe(true);
    expect(json.data.input).toBeUndefined();
    expect(json.data.modelId).toBeUndefined();
    expect(json.data.proxyId).toBeUndefined();
  });

  test("proxyId 'none' is passed through as string", async () => {
    const res = await jsonApp({ proxyId: "none" });
    const json = (await res.json()) as ParseResult;

    expect(json.ok).toBe(true);
    expect(json.data.proxyId).toBe("none");
  });
});
