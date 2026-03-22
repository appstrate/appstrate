import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { parseRequestInput } from "../../src/services/input-parser.ts";
import type { ParsedInput } from "../../src/services/input-parser.ts";

// --- Helpers ---

/** Create a minimal Hono app that parses a JSON body via parseRequestInput (no schema). */
function jsonApp(body: unknown) {
  const app = new Hono();
  app.post("/", async (c) => {
    // No inputSchema → skips validation + file handling entirely
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
  it("parses modelId and proxyId from JSON body", async () => {
    const res = await jsonApp({
      input: { text: "hello" },
      modelId: "model-abc",
      proxyId: "proxy-def",
    });
    const json = (await res.json()) as any;

    expect(json.input).toEqual({ text: "hello" });
    expect(json.modelId).toBe("model-abc");
    expect(json.proxyId).toBe("proxy-def");
  });

  it("modelId and proxyId are undefined when not provided", async () => {
    const res = await jsonApp({ input: { text: "hello" } });
    const json = (await res.json()) as any;

    expect(json.modelId).toBeUndefined();
    expect(json.proxyId).toBeUndefined();
  });

  it("works with empty body", async () => {
    const res = await jsonApp({});
    const json = (await res.json()) as any;

    expect(json.input).toBeUndefined();
    expect(json.modelId).toBeUndefined();
    expect(json.proxyId).toBeUndefined();
  });

  it("proxyId 'none' is passed through as string", async () => {
    const res = await jsonApp({ proxyId: "none" });
    const json = (await res.json()) as any;

    expect(json.proxyId).toBe("none");
  });
});
