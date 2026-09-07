// SPDX-License-Identifier: Apache-2.0

/**
 * Which saved keys a form offers for the provider it names.
 *
 * The two halves answer different questions. A provider that pins its own
 * endpoint is identified BY that endpoint — several of them share one
 * `apiShape`, so the URL is what tells Groq from Mistral. A provider the
 * operator points wherever they like has no such URL to compare against: every
 * key was saved against a host of its own, and requiring the typed URL to match
 * meant a saved key only reappeared once its exact endpoint had been retyped.
 */

import { describe, it, expect } from "bun:test";
import { selectableCredentials } from "../model-credential-filter.ts";
import type { ModelProviderCredentialInfo } from "../../hooks/use-model-provider-credentials.ts";

function credential(overrides: Partial<ModelProviderCredentialInfo>): ModelProviderCredentialInfo {
  return {
    id: "cred_1",
    label: "localhost:11434 · OpenAI-compatible",
    apiShape: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    source: "custom",
    authMode: "api_key",
    providerId: "openai-compatible",
    created_by: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

const OPENAI_COMPATIBLE = {
  providerId: "openai-compatible",
  authMode: "api_key" as const,
  baseUrlOverridable: true,
};
const GROQ = {
  providerId: "groq",
  authMode: "api_key" as const,
  baseUrlOverridable: false,
};
const CLAUDE_CODE = {
  providerId: "claude-code",
  authMode: "oauth2" as const,
  baseUrlOverridable: false,
};

const OLLAMA = credential({});
const VLLM = credential({
  id: "cred_2",
  label: "vllm.internal · OpenAI-compatible",
  baseUrl: "https://vllm.internal/v1",
});
const GROQ_KEY = credential({
  id: "cred_groq",
  label: "Groq",
  providerId: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
});

function ids(
  input: Parameters<typeof selectableCredentials<ModelProviderCredentialInfo>>[0],
): string[] {
  return selectableCredentials(input).map((k) => k.id);
}

describe("selectableCredentials — a provider pointed at the operator's endpoint", () => {
  it("offers every key of that provider, whatever URL is typed", () => {
    expect(
      ids({
        credentials: [OLLAMA, VLLM],
        provider: OPENAI_COMPATIBLE,
        apiShape: "openai-completions",
        baseUrl: "http://localhost:9999",
      }),
    ).toEqual(["cred_1", "cred_2"]);
  });

  it("still refuses a key that belongs to another provider", () => {
    // Same apiShape — that is exactly why `providerId` is the match here.
    expect(
      ids({
        credentials: [OLLAMA, GROQ_KEY],
        provider: OPENAI_COMPATIBLE,
        apiShape: "openai-completions",
        baseUrl: "",
      }),
    ).toEqual(["cred_1"]);
  });
});

describe("selectableCredentials — a provider that pins its own endpoint", () => {
  it("matches on the API shape and the endpoint, trailing slash or not", () => {
    expect(
      ids({
        credentials: [OLLAMA, GROQ_KEY],
        provider: GROQ,
        apiShape: "openai-completions",
        baseUrl: "https://api.groq.com/openai/v1/",
      }),
    ).toEqual(["cred_groq"]);
  });

  it("offers nothing before the endpoint is known", () => {
    expect(
      ids({
        credentials: [OLLAMA, GROQ_KEY],
        provider: GROQ,
        apiShape: "openai-completions",
        baseUrl: "",
      }),
    ).toEqual([]);
  });
});

describe("selectableCredentials — connections and system keys", () => {
  it("pins an OAuth provider to its own connections", () => {
    const connection = credential({
      id: "cred_cc",
      label: "Claude Code",
      authMode: "oauth2",
      providerId: "claude-code",
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });
    expect(
      ids({
        credentials: [connection, OLLAMA],
        provider: CLAUDE_CODE,
        apiShape: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
    ).toEqual(["cred_cc"]);
  });

  it("never offers a built-in key: its slug id is not the UUID the FK wants", () => {
    const systemKey = credential({ id: "openai-compatible", source: "built-in" });
    expect(
      ids({
        credentials: [systemKey],
        provider: OPENAI_COMPATIBLE,
        apiShape: "openai-completions",
        baseUrl: "http://localhost:11434/v1",
      }),
    ).toEqual([]);
  });

  it("offers nothing until a provider is picked", () => {
    expect(ids({ credentials: [OLLAMA], provider: undefined, apiShape: "", baseUrl: "" })).toEqual(
      [],
    );
  });
});
