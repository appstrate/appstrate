// SPDX-License-Identifier: Apache-2.0

/**
 * Policy guard for the two family lists that look duplicated but aren't.
 *
 * `CHAT_USABLE_FAMILIES` ("can the chat use it at all") is a deliberate strict
 * superset of the llm-proxy families the model binding routes ("does the
 * llm-proxy route it") — the extra members are the oauth subscription shapes,
 * which reach their provider natively instead of through the proxy.
 *
 * The drift this catches: `pickModel` gates on `CHAT_USABLE_FAMILIES` BEFORE
 * a binding is ever built, so a proxy family added to `proxyBaseUrl` but not to
 * `CHAT_USABLE_FAMILIES` is silently unreachable — the model just disappears
 * from the picker with no error anywhere.
 *
 * To catch that, the routed set must be DISCOVERED, never restated: a
 * hand-copied list of proxy families is a third source of truth that stays
 * green precisely when a new `case` is added to `proxyBaseUrl` alone. So we
 * enumerate every `ModelApiShape` and probe the binding resolver — which is
 * `proxyBaseUrl` (a private switch) made observable: it reports `unsupported`
 * for exactly the families that switch does not route.
 *
 * The enumeration comes from `PROVIDER_BY_API`, a `Record<ModelApiShape, …>`:
 * being keyed by the closed union, the compiler refuses it a missing member,
 * so a tenth apiShape lands in this loop the moment it is declared.
 */

import { describe, expect, it } from "bun:test";
import { PROVIDER_BY_API } from "@appstrate/runner-pi";
import { CHAT_USABLE_FAMILIES } from "../src/chat-families.ts";
import { pickModel, type OrgModel } from "../src/llm.ts";
import { resolvePiChatModelBinding } from "../src/pi-chat/model-binding.ts";

const ORIGIN = "http://127.0.0.1:3000";

/** Every declared `ModelApiShape`, exhaustive by construction. */
const ALL_API_SHAPES = Object.keys(PROVIDER_BY_API);

function model(apiShape: string): OrgModel {
  return { id: "preset_1", modelId: "upstream-model", apiShape };
}

function bind(apiShape: string) {
  return resolvePiChatModelBinding({
    model: model(apiShape),
    // An API-key row: the branch that must consult the proxy family table.
    subscription: { subscription: false },
    origin: ORIGIN,
    mintBearer: () => "tok",
  });
}

/** `proxyBaseUrl` routes it ⟺ the resolver returns a ready proxy binding. */
function isProxyRouted(apiShape: string): boolean {
  return bind(apiShape).status === "ready";
}

const proxyRouted = ALL_API_SHAPES.filter(isProxyRouted);

describe("chat family policy", () => {
  it("finds the proxy-routed families by probing, not by restating them", () => {
    // Non-vacuity guard: if the resolver ever reported `unsupported` for every
    // shape (a refactor breaking the probe), the superset test below would
    // pass over an empty set and assert nothing at all.
    expect(ALL_API_SHAPES.length).toBeGreaterThan(1);
    expect(proxyRouted.length).toBeGreaterThan(0);
  });

  it("keeps CHAT_USABLE_FAMILIES a superset of every proxy-routed family", () => {
    // A proxy family missing here would be filtered out by pickModel before a
    // binding could be built — the model vanishes from the picker.
    for (const family of proxyRouted) {
      expect(CHAT_USABLE_FAMILIES.has(family)).toBe(true);
      expect(pickModel([model(family)]).apiShape).toBe(family);
    }
  });

  it("admits no family that is not a declared ModelApiShape", () => {
    // The other direction: a typo or a shape retired from the union would
    // leave a member here that no model row can ever carry.
    for (const family of CHAT_USABLE_FAMILIES) {
      expect(ALL_API_SHAPES).toContain(family);
    }
  });

  it("admits the codex subscription family without a proxy target", () => {
    // The reason the superset exists: usable by the chat (its oauth credential
    // reaches the provider natively), but it must never resolve a proxy route.
    expect(CHAT_USABLE_FAMILIES.has("openai-codex-responses")).toBe(true);
    expect(bind("openai-codex-responses")).toEqual({ status: "unsupported" });
  });
});
