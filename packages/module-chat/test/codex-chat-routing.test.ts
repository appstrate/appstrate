// SPDX-License-Identifier: Apache-2.0

/**
 * Codex is a first-class chat provider: selectable by the picker, then routed
 * (by `providerId === "codex"`, in chat-stream.ts) to the official Codex CLI
 * engine behind the non-forging codex-sdk gateway — NOT through the llm-proxy
 * adapter path. So it is IN the usable-families set but has no `proxyTarget`
 * (the engine, not the proxy, serves it — same shape as claude-code).
 */

import { describe, expect, it } from "bun:test";
import { CHAT_USABLE_FAMILIES, CODEX_API_SHAPE } from "../src/chat-families.ts";
import { pickModel, proxyTarget, type OrgModel } from "../src/llm.ts";

const codex: OrgModel = {
  id: "m_codex",
  modelId: "gpt-5.4-mini",
  apiShape: CODEX_API_SHAPE,
  providerId: "codex",
  enabled: true,
};
const openai: OrgModel = {
  id: "m_openai",
  modelId: "gpt-4o",
  apiShape: "openai-completions",
  providerId: "openai",
  enabled: true,
};

describe("codex chat routing", () => {
  it("CHAT_USABLE_FAMILIES includes the codex apiShape", () => {
    expect(CHAT_USABLE_FAMILIES.has(CODEX_API_SHAPE)).toBe(true);
  });

  it("proxyTarget returns null for codex (engine-routed, not proxied)", () => {
    expect(proxyTarget(CODEX_API_SHAPE)).toBeNull();
  });

  it("pickModel selects a codex model when it is the default", () => {
    const chosen = pickModel([{ ...codex, isDefault: true }, openai]);
    expect(chosen.id).toBe("m_codex");
  });

  it("pickModel resolves an explicitly-requested codex preset id", () => {
    const chosen = pickModel([codex, openai], "m_codex");
    expect(chosen.providerId).toBe("codex");
  });

  it("pickModel works when only codex is connected", () => {
    expect(pickModel([codex]).id).toBe("m_codex");
  });
});
