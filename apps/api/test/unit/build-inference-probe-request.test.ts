// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the OAuth inference probe request builder (Codex).
 *
 * Why these tests exist: bug 4 in PR #397 was caused by `chatgpt-account-id`
 * silently being dropped during a refactor — Codex's chatgpt.com backend
 * 401s every request when the header is absent. These tests pin every
 * load-bearing field of the Codex wire format so a future change either
 * keeps the contract or fails the suite.
 *
 * The Claude Code subscription probe is intentionally absent — Anthropic
 * Consumer ToS forbids using OAuth subscription tokens in third-party
 * tools, and PR 6 removed the wire-format stealth code from this repo.
 */

import { describe, it, expect } from "bun:test";
import { buildCodexInferenceRequest } from "../../src/services/org-models.ts";

describe("buildCodexInferenceRequest", () => {
  it("targets `${baseUrl}/codex/responses`", () => {
    const req = buildCodexInferenceRequest({
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.4-mini",
      apiKey: "jwt",
      accountId: "acc-1",
    });
    expect(req.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(req.method).toBe("POST");
  });

  it("strips trailing slashes from baseUrl (defense against pasted/registry-derived URLs)", () => {
    const req = buildCodexInferenceRequest({
      baseUrl: "https://chatgpt.com/backend-api///",
      modelId: "m",
      apiKey: "k",
      accountId: "a",
    });
    expect(req.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("carries every load-bearing header (Bearer, chatgpt-account-id, originator, OpenAI-Beta, accept, content-type)", () => {
    const req = buildCodexInferenceRequest({
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.4-mini",
      apiKey: "jwt-token",
      accountId: "acc-uuid-36chars",
    });
    expect(req.headers).toEqual({
      Authorization: "Bearer jwt-token",
      "chatgpt-account-id": "acc-uuid-36chars",
      originator: "pi",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    });
  });

  it("body matches pi-ai's openai-codex-responses shape (model, store=false, stream=true, instructions, input, include)", () => {
    const req = buildCodexInferenceRequest({
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.5",
      apiKey: "k",
      accountId: "a",
    });
    const body = JSON.parse(req.body) as Record<string, unknown>;
    // Pin every key — Codex rejects unknown shapes silently as 400 Bad Request.
    expect(Object.keys(body).sort()).toEqual(
      ["include", "input", "instructions", "model", "store", "stream"].sort(),
    );
    expect(body.model).toBe("gpt-5.5");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("ping");
    expect(body.include).toEqual([]);
    // The `input` array shape is pi-ai-specific (one user message with one
    // input_text content block). Pin all four nested fields.
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "ping" }],
      },
    ]);
  });
});
