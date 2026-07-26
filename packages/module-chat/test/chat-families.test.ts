// SPDX-License-Identifier: Apache-2.0

/**
 * Policy guard for the two family lists that look duplicated but aren't.
 *
 * `CHAT_USABLE_FAMILIES` ("can the chat use it at all") is a deliberate strict
 * superset of the llm-proxy families `modelFromFamily`/`proxyTarget` bind
 * ("does the llm-proxy route it") — the extra members are the oauth
 * subscription shapes that run on the in-process Pi engine instead.
 *
 * The drift this catches: `pickModel` gates on `CHAT_USABLE_FAMILIES` BEFORE
 * `modelFromFamily` is ever called, so a proxy family added to `proxyTarget`
 * but not to `CHAT_USABLE_FAMILIES` is silently unreachable — the model just
 * disappears from the picker with no error anywhere.
 */

import { describe, expect, it } from "bun:test";
import { CHAT_USABLE_FAMILIES } from "../src/chat-families.ts";
import { modelFromFamily, pickModel, type OrgModel } from "../src/llm.ts";

const ORIGIN = "http://127.0.0.1:3000";

/** Families `/api/llm-proxy/*` routes today (apps/api/src/routes/llm-proxy.ts). */
const PROXY_ROUTED_FAMILIES = ["openai-completions", "anthropic-messages", "mistral-conversations"];

/** Families that reach the in-process Pi engine, never the llm-proxy. */
const PI_ENGINE_FAMILIES = ["openai-codex-responses"];

function model(apiShape: string): OrgModel {
  return { id: "preset_1", modelId: "upstream-model", apiShape };
}

function bind(apiShape: string) {
  return modelFromFamily(
    model(apiShape),
    ORIGIN,
    {},
    () => "tok",
    (async () => new Response("{}")) as typeof fetch,
  );
}

describe("chat family policy", () => {
  it("binds every llm-proxy-routed family to a proxy target", () => {
    for (const family of PROXY_ROUTED_FAMILIES) {
      expect(bind(family)).not.toBeNull();
    }
  });

  it("keeps CHAT_USABLE_FAMILIES a superset of the proxy-bound families", () => {
    // A proxy family missing here would be filtered out by pickModel before
    // modelFromFamily could bind it.
    for (const family of PROXY_ROUTED_FAMILIES) {
      expect(CHAT_USABLE_FAMILIES.has(family)).toBe(true);
      expect(pickModel([model(family)]).apiShape).toBe(family);
    }
  });

  it("admits the Pi-engine subscription families without a proxy target", () => {
    // These are the reason the superset exists: usable by the chat, but they
    // must never resolve a proxy route.
    for (const family of PI_ENGINE_FAMILIES) {
      expect(CHAT_USABLE_FAMILIES.has(family)).toBe(true);
      expect(bind(family)).toBeNull();
    }
  });

  it("rejects a family that is neither proxy-routed nor Pi-engine", () => {
    expect(CHAT_USABLE_FAMILIES.has("google-generative-ai")).toBe(false);
    expect(bind("google-generative-ai")).toBeNull();
  });

  it("accounts for every usable family (no unclassified member)", () => {
    // Forces this file to be updated when a family is added, rather than the
    // new member silently escaping both branches of the policy.
    expect([...CHAT_USABLE_FAMILIES].sort()).toEqual(
      [...PROXY_ROUTED_FAMILIES, ...PI_ENGINE_FAMILIES].sort(),
    );
  });
});
