// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: codex (an OAuth-subscription provider with no forging path
 * and no SDK driver) must never be usable in chat. It is excluded from the
 * usable-families set and has no proxy target, so a connected codex model is
 * neither offered by the picker nor routable to a (non-existent) proxy route —
 * it surfaces a clear error instead of a bare 404. Mirrors the run-side
 * assertRunnableOnEngine refusal.
 */

import { describe, expect, test } from "bun:test";
import { CHAT_USABLE_FAMILIES, CODEX_API_SHAPE } from "../src/chat-families.ts";
import { pickModel, proxyTarget, type OrgModel } from "../src/llm.ts";

const codex: OrgModel = {
  id: "m_codex",
  modelId: "gpt-5-codex",
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

describe("codex chat exclusion", () => {
  test("CHAT_USABLE_FAMILIES does not include the codex apiShape", () => {
    expect(CHAT_USABLE_FAMILIES.has(CODEX_API_SHAPE)).toBe(false);
  });

  test("proxyTarget returns null for the codex family (no route)", () => {
    expect(proxyTarget(CODEX_API_SHAPE)).toBeNull();
  });

  test("pickModel never selects a codex model, even when it is the default", () => {
    const chosen = pickModel([{ ...codex, isDefault: true }, openai]);
    expect(chosen.id).toBe("m_openai");
  });

  test("pickModel throws a clear error when only codex is connected", () => {
    expect(() => pickModel([codex])).toThrow(/Aucun modèle utilisable/);
  });

  test("explicitly requesting a codex preset id throws a clear error", () => {
    // codex is filtered out of the pool, so the requested id is unresolvable
    // and surfaces a clear "not an enabled model" error rather than routing.
    expect(() => pickModel([codex, openai], "m_codex")).toThrow(/not an enabled model/);
  });
});
