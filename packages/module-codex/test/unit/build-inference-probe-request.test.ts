// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the Codex inference probe — the only path that
 * exercises the chatgpt.com wire format end-to-end. Goes through the
 * `buildInferenceProbe` hook (the same entry point the platform's
 * `runInferenceProbe` helper uses); no module-private exports.
 *
 * Why these tests exist: bug 4 in PR #397 was caused by `chatgpt-account-id`
 * silently being dropped during a refactor — Codex's chatgpt.com backend
 * 401s every request when the header is absent. These tests pin every
 * load-bearing field of the Codex wire format so a future change either
 * keeps the contract or fails the suite.
 */

import { describe, it, expect } from "bun:test";
import codexModule from "../../src/index.ts";
import type { InferenceProbeBuildError, InferenceProbeRequest } from "@appstrate/core/module";

const codex = codexModule.modelProviders?.()[0];

function probe(args: {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  accountId?: string;
}): InferenceProbeRequest | InferenceProbeBuildError | null | undefined {
  return codex?.hooks?.buildInferenceProbe?.(args);
}

function assertRequest(
  out: InferenceProbeRequest | InferenceProbeBuildError | null | undefined,
): asserts out is InferenceProbeRequest {
  if (!out || "error" in out) throw new Error("expected probe request, got error/null");
}

describe("codex inference probe — wire format", () => {
  it("targets `${baseUrl}/codex/responses`", () => {
    const req = probe({
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.4-mini",
      apiKey: "jwt",
      accountId: "acc-1",
    });
    assertRequest(req);
    expect(req.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(req.method).toBe("POST");
  });

  it("strips trailing slashes from baseUrl (defense against pasted/registry-derived URLs)", () => {
    const req = probe({
      baseUrl: "https://chatgpt.com/backend-api///",
      modelId: "m",
      apiKey: "k",
      accountId: "a",
    });
    assertRequest(req);
    expect(req.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("carries every load-bearing header (Bearer, chatgpt-account-id, originator, OpenAI-Beta, accept, content-type)", () => {
    const req = probe({
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.4-mini",
      apiKey: "jwt-token",
      accountId: "acc-uuid-36chars",
    });
    assertRequest(req);
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
    const req = probe({
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.5",
      apiKey: "k",
      accountId: "a",
    });
    assertRequest(req);
    const body = JSON.parse(req.body!) as Record<string, unknown>;
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

  it("returns AUTH_FAILED structured error when accountId is missing", () => {
    const out = probe({
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.5",
      apiKey: "jwt",
    });
    expect(out).toEqual({
      error: "AUTH_FAILED",
      message: "Missing chatgpt-account-id (token may not be a valid Codex JWT)",
    });
  });
});
