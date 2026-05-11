// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the OAuth inference probe request builders.
 *
 * Why these tests exist: bug 5 in PR #397 was caused by Anthropic enforcing
 * its third-party OAuth ban via request fingerprinting — drop any of the
 * stealth-mode headers or the system preamble and every request 429s. The
 * headers + body are mirrored from pi-ai (cf.
 * node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js) and any
 * silent drift here ships broken to prod. Same risk for Codex's
 * `chatgpt-account-id` header (bug 4 — the field was silently dropped from
 * the read path during a refactor).
 *
 * The tests pin every load-bearing field of the wire format. If you change
 * a header value or rename a body key, you have to confirm pi-ai is doing
 * the same — and update the test in the same commit.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildCodexInferenceRequest,
  buildClaudeCodeInferenceRequest,
  CLAUDE_CODE_CLI_VERSION,
  CLAUDE_CODE_STEALTH_SYSTEM_PROMPT,
} from "../../src/services/org-models.ts";

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

describe("buildClaudeCodeInferenceRequest", () => {
  it("targets `${baseUrl}/v1/messages`", () => {
    const req = buildClaudeCodeInferenceRequest({
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-opus-4-7",
      apiKey: "oat-token",
    });
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.method).toBe("POST");
  });

  it("strips trailing slashes from baseUrl", () => {
    const req = buildClaudeCodeInferenceRequest({
      baseUrl: "https://api.anthropic.com//",
      modelId: "m",
      apiKey: "k",
    });
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("carries every stealth-mode header required by Anthropic's third-party enforcement", () => {
    // All five signals below are load-bearing — Anthropic 429s the request
    // if any one is missing or modified. cf. pi-ai anthropic.js.
    const req = buildClaudeCodeInferenceRequest({
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-opus-4-7",
      apiKey: "oat-token",
    });
    expect(req.headers["Authorization"]).toBe("Bearer oat-token");
    expect(req.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(req.headers["user-agent"]).toBe(`claude-cli/${CLAUDE_CODE_CLI_VERSION}`);
    expect(req.headers["x-app"]).toBe("cli");
    expect(req.headers["accept"]).toBe("application/json");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("body wraps the system preamble in the typed-content-block array shape (NOT a plain string)", () => {
    // Anthropic accepts both `system: "string"` and `system: [{type:"text",text}]`
    // — but the third-party enforcement specifically validates the array
    // form. Switching to a plain string was one of the failure modes during
    // bug 5 debugging.
    const req = buildClaudeCodeInferenceRequest({
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-opus-4-7",
      apiKey: "k",
    });
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.system).toEqual([{ type: "text", text: CLAUDE_CODE_STEALTH_SYSTEM_PROMPT }]);
  });

  it("body uses max_tokens=1 (cheapest possible probe)", () => {
    const req = buildClaudeCodeInferenceRequest({
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-opus-4-7",
      apiKey: "k",
    });
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.max_tokens).toBe(1);
    expect(body.model).toBe("claude-opus-4-7");
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("system preamble matches the exact string Anthropic enforces", () => {
    // The string is verbatim from pi-ai. Anthropic's enforcement appears
    // to do a substring match on this preamble — paraphrasing it (even
    // capitalization differences) trips the third-party tier filter.
    expect(CLAUDE_CODE_STEALTH_SYSTEM_PROMPT).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
  });
});

describe("CLAUDE_CODE_CLI_VERSION sync with pi-ai", () => {
  // Drift detector. The version we put in `user-agent` must match what pi-ai
  // ships — Anthropic appears to maintain an internal allowlist of recent
  // Claude Code CLI versions, so an older value silently 429s. This test
  // reads pi-ai's compiled provider file and asserts our local constant
  // tracks `claudeCodeVersion` exactly. When the test fails after a pi-ai
  // bump, do NOT just update the constant blindly — read pi-ai's CHANGELOG
  // to confirm the bump is unrelated to a breaking enforcement change.
  it("matches `claudeCodeVersion` in @mariozechner/pi-ai", () => {
    // pi-ai gates deep imports via its `exports` field — `require.resolve`
    // refuses internal paths. Anchor on package.json (always resolvable),
    // then read the provider source from the same directory.
    const pkgPath = require.resolve("@mariozechner/pi-ai/package.json");
    const piAiAnthropicPath = join(dirname(pkgPath), "dist/providers/anthropic.js");
    const source = readFileSync(piAiAnthropicPath, "utf8");
    const match = source.match(/claudeCodeVersion\s*=\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const piAiVersion = match![1]!;
    expect(CLAUDE_CODE_CLI_VERSION).toBe(piAiVersion);
  });

  it("can resolve pi-ai's package.json (sanity — fails loudly if pi-ai isn't installed)", () => {
    // Independent of the version assertion above so the failure mode is
    // unambiguous: missing dep vs. version drift.
    const pkgPath = require.resolve("@mariozechner/pi-ai/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name: string };
    expect(pkg.name).toBe("@mariozechner/pi-ai");
  });
});
