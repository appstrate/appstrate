// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `parseServedModelIds` — the pure half of model listing — plus the
 * one `listServedModelIds` verdict reachable without a network: a base URL the
 * egress guard refuses. The rest of the network half is covered where it is
 * used, through the injected `listModels` dependency of
 * `discoverAvailableModels`.
 */

import { describe, it, expect } from "bun:test";
import {
  listServedModelIds,
  parseServedModelIds,
} from "../../src/services/model-providers/model-listing.ts";

const DATA_SHAPES = [
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "bedrock-converse-stream",
  "mistral-conversations",
  "anthropic-messages",
  "some-unknown-shape",
];

describe("parseServedModelIds", () => {
  for (const apiShape of DATA_SHAPES) {
    it(`${apiShape}: reads ids from { data: [{ id }] } in response order`, () => {
      expect(
        parseServedModelIds(apiShape, {
          data: [{ id: "gpt-5" }, { id: "gpt-4o", display_name: "GPT-4o" }],
        }),
      ).toEqual(["gpt-5", "gpt-4o"]);
    });
  }

  it("google-generative-ai: strips the `models/` prefix from `name`", () => {
    expect(
      parseServedModelIds("google-generative-ai", {
        models: [{ name: "models/gemini-3-pro" }, { name: "models/gemini-3-flash" }],
      }),
    ).toEqual(["gemini-3-pro", "gemini-3-flash"]);
  });

  it("google-vertex: reads the same shape and leaves an unprefixed name alone", () => {
    expect(
      parseServedModelIds("google-vertex", {
        models: [{ name: "models/gemini-3-pro" }, { name: "gemini-3-flash" }],
      }),
    ).toEqual(["gemini-3-pro", "gemini-3-flash"]);
  });

  it("google shapes ignore a `data` array (and vice versa)", () => {
    expect(parseServedModelIds("google-vertex", { data: [{ id: "gpt-5" }] })).toBeNull();
    expect(parseServedModelIds("openai-responses", { models: [{ name: "m" }] })).toBeNull();
  });

  it("dedupes, keeping the first occurrence", () => {
    expect(
      parseServedModelIds("openai-responses", {
        data: [{ id: "a" }, { id: "b" }, { id: "a" }],
      }),
    ).toEqual(["a", "b"]);
  });

  it("caps a runaway listing at 1000 ids", () => {
    const data = Array.from({ length: 1500 }, (_, i) => ({ id: `m-${i}` }));
    const ids = parseServedModelIds("openai-responses", { data });
    expect(ids).toHaveLength(1000);
    expect(ids?.[999]).toBe("m-999");
  });

  it("accepts an empty listing as an empty list, not an unreadable one", () => {
    expect(parseServedModelIds("openai-responses", { data: [] })).toEqual([]);
    expect(parseServedModelIds("google-vertex", { models: [] })).toEqual([]);
  });

  it("returns null for a body that is not an object", () => {
    for (const body of [null, undefined, "models", 42, [{ id: "a" }]]) {
      expect(parseServedModelIds("openai-responses", body)).toBeNull();
    }
  });

  it("returns null when the array is missing or not an array", () => {
    expect(parseServedModelIds("openai-responses", {})).toBeNull();
    expect(parseServedModelIds("openai-responses", { data: { id: "a" } })).toBeNull();
    expect(parseServedModelIds("google-generative-ai", {})).toBeNull();
  });

  it("skips entries with no usable id and keeps the readable ones", () => {
    expect(
      parseServedModelIds("openai-responses", {
        data: [{ id: "a" }, { id: 7 }, "b", null, { display_name: "no id" }, { id: "c" }],
      }),
    ).toEqual(["a", "c"]);
    expect(parseServedModelIds("google-vertex", { models: [{ id: "a" }, { name: "m" }] })).toEqual([
      "m",
    ]);
  });

  it("skips an empty id (or one that is nothing but the `models/` prefix)", () => {
    expect(parseServedModelIds("openai-responses", { data: [{ id: "" }] })).toEqual([]);
    expect(parseServedModelIds("openai-responses", { data: [{}] })).toEqual([]);
    expect(
      parseServedModelIds("google-vertex", { models: [{ name: "models/" }, { name: "models/m" }] }),
    ).toEqual(["m"]);
  });
});

describe("listServedModelIds", () => {
  it("keeps the BLOCKED_URL verdict distinct from an unreachable provider", async () => {
    // The egress guard refuses the link-local metadata address before any
    // socket is opened; the operator lifts such a refusal with
    // EGRESS_ALLOW_INTERNAL_HOSTS, so the caller must be able to tell it from
    // "the provider did not answer". (Loopback would not do: the test preload
    // puts 127.0.0.1 on that very allowlist.)
    const result = await listServedModelIds({
      apiShape: "openai-responses",
      baseUrl: "http://169.254.169.254/v1",
      apiKey: "k",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("BLOCKED_URL");
  });
});
