// SPDX-License-Identifier: Apache-2.0

/**
 * What "ask this endpoint what it serves" puts on the wire.
 *
 * The route takes exactly one of two forms and answers 400 to both at once or
 * neither: a saved organization key, or a key typed for this one request
 * against the configuration's endpoint.
 */

import { describe, it, expect } from "bun:test";
import { buildDiscoverBody, parsesAsUrl } from "../model-discovery.ts";

describe("buildDiscoverBody — a saved key", () => {
  it("names the key and nothing else: it already carries key and endpoint", () => {
    expect(buildDiscoverBody("openai-compatible", { credentialId: "cred_1" })).toEqual({
      credentialId: "cred_1",
    });
  });
});

describe("buildDiscoverBody — a key typed inline", () => {
  it("asks the configuration's endpoint with the key, trimmed", () => {
    expect(
      buildDiscoverBody("openai-compatible", { inlineApiKey: "  sk-test  ", configId: "cfg_1" }),
    ).toEqual({ providerId: "openai-compatible", api_key: "sk-test", config_id: "cfg_1" });
  });
});

describe("parsesAsUrl", () => {
  it("accepts only an HTTP(S) endpoint", () => {
    expect(parsesAsUrl(" http://localhost:11434/v1 ")).toBe(true);
    expect(parsesAsUrl("https://api.example.com")).toBe(true);
    expect(parsesAsUrl("ftp://example.com")).toBe(false);
    expect(parsesAsUrl("not a url")).toBe(false);
  });
});
