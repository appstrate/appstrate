// SPDX-License-Identifier: Apache-2.0

/**
 * What "ask this endpoint what it serves" puts on the wire.
 *
 * The route takes exactly one of two forms and answers 400 to both at once or
 * neither, so which one is emitted is the whole contract — and it is decided by
 * two facts the form holds: whether a saved credential is selected, and whether
 * the provider lets the operator move the base URL.
 */

import { describe, it, expect } from "bun:test";
import { buildDiscoverBody, type DiscoverProvider } from "../model-discovery.ts";

const OPENAI_COMPATIBLE: DiscoverProvider = {
  providerId: "openai-compatible",
  baseUrlOverridable: true,
};
const ANTHROPIC: DiscoverProvider = { providerId: "anthropic", baseUrlOverridable: false };

describe("buildDiscoverBody — a saved credential", () => {
  it("names the credential and nothing else: it already carries key and endpoint", () => {
    expect(
      buildDiscoverBody({
        credentialId: "cred_1",
        provider: OPENAI_COMPATIBLE,
        inlineApiKey: "sk-typed",
        baseUrl: "http://localhost:11434/v1",
      }),
    ).toEqual({ credential_id: "cred_1" });
  });
});

describe("buildDiscoverBody — a key typed inline", () => {
  it("describes the endpoint the key opens, trimmed", () => {
    expect(
      buildDiscoverBody({
        credentialId: null,
        provider: OPENAI_COMPATIBLE,
        inlineApiKey: "  sk-test  ",
        baseUrl: "  http://localhost:11434/v1  ",
      }),
    ).toEqual({
      provider_id: "openai-compatible",
      api_key: "sk-test",
      base_url_override: "http://localhost:11434/v1",
    });
  });

  it("omits the base URL for a provider that pins its own endpoint", () => {
    // The route accepts `base_url_override` only where `baseUrlOverridable` is
    // true; the form still holds the pinned default in the field.
    expect(
      buildDiscoverBody({
        credentialId: null,
        provider: ANTHROPIC,
        inlineApiKey: "sk-ant-test",
        baseUrl: "https://api.anthropic.com",
      }),
    ).toEqual({ provider_id: "anthropic", api_key: "sk-ant-test" });
  });
});
