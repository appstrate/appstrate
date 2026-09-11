// SPDX-License-Identifier: Apache-2.0

/**
 * The two pieces of the alias boundary the SIDECAR itself still owns: the
 * alias-refusal envelope it substitutes for any upstream error body
 * (`app.ts`, `pi-messages-backend.ts`) and the boot-time parse of the swap
 * descriptor off `PI_MODEL_SWAP_JSON`.
 *
 * The response-side `model` rewrite used to be tested here too. Since #1202 the
 * sidecar terminates the client dialect and re-originates against the backing
 * rather than proxying, so it calls neither `swapResponseModelJson` nor
 * `createSseModelSwapStream` — those tests now live beside the implementation,
 * in `packages/core/test/model-swap-rewrite.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { ALIAS_CLIENT_API_SHAPE } from "@appstrate/core/model-swap";
import { syntheticAliasErrorBody, parseModelSwapEnv } from "../model-swap.ts";

const swap = {
  alias: "appstrate-medium",
  real: "deepseek-chat",
  clientApiShape: ALIAS_CLIENT_API_SHAPE,
  backingApiShape: "openai-completions" as const,
};

describe("syntheticAliasErrorBody", () => {
  it("names the alias and the neutral message, never the real id", () => {
    const out = syntheticAliasErrorBody(swap);
    expect(out).toContain("appstrate-medium");
    expect(out).toContain("Upstream model error");
    expect(out).not.toContain("deepseek-chat");
  });

  it("includes the upstream status when given", () => {
    expect(syntheticAliasErrorBody(swap, 429)).toContain("429");
  });

  it("parses as a JSON error envelope (type + error.message)", () => {
    const parsed = JSON.parse(syntheticAliasErrorBody(swap, 503));
    expect(parsed.type).toBe("error");
    expect(typeof parsed.error.message).toBe("string");
  });
});

/**
 * `parseModelSwapEnv` — the process boundary the swap descriptor actually
 * crosses (`PI_MODEL_SWAP_JSON`, read once in `server.ts` at boot). It used to
 * be a blind `as ModelSwap` cast, so a platform predating a protocol field produced a
 * swap that failed closed at request time: correct, but one opaque 404 per
 * inference attempt and no statement of the cause. The guard turns that into a
 * single boot failure naming the field — and never naming its value, because
 * these logs are operator-visible and the backing is what an alias hides.
 */
describe("parseModelSwapEnv", () => {
  // `as const` only so `toEqual` can compare against the `ModelSwap` the parser
  // returns; the parser itself receives these as raw JSON text.
  const wellFormed = {
    alias: "appstrate-medium",
    real: "deepseek-chat",
    clientApiShape: "pi-messages" as const,
    backingApiShape: "openai-completions" as const,
    backing: { providerId: "deepseek", reasoning: false, input: ["text"] },
  };

  it("accepts a well-formed descriptor", () => {
    expect(parseModelSwapEnv(JSON.stringify(wellFormed))).toEqual(wellFormed);
  });

  it("keeps the optional adaptive-reasoning correction", () => {
    const adaptive = {
      alias: "appstrate-adaptive",
      real: "claude-sonnet-4-6",
      clientApiShape: "pi-messages" as const,
      backingApiShape: "anthropic-messages" as const,
      backing: { providerId: "anthropic", reasoning: true, input: ["text"] },
      anthropicAdaptiveReasoning: { effort: "max" as const },
    };
    expect(parseModelSwapEnv(JSON.stringify(adaptive))).toEqual(adaptive);
  });

  it("keeps a re-origination descriptor whole", () => {
    // What an ALIASED run actually ships: the container speaks the canonical
    // dialect, the backing speaks the vendor's, and the catalog needed to
    // rebuild the backing's pi model rides on the same private descriptor.
    const reoriginating = {
      alias: "appstrate-medium",
      real: "deepseek-chat",
      clientApiShape: "pi-messages" as const,
      backingApiShape: "openai-completions" as const,
      backing: {
        providerId: "deepseek",
        reasoning: true,
        reasoningLevelMap: { high: "high" as const },
        input: ["text"],
      },
    };
    expect(parseModelSwapEnv(JSON.stringify(reoriginating))).toEqual(reoriginating);
  });

  it("rejects a descriptor with no protocol fields (the pre-#1198 platform payload)", () => {
    expect(() => parseModelSwapEnv(JSON.stringify({ alias: "a", real: "deepseek-chat" }))).toThrow(
      /"clientApiShape"/,
    );
  });

  it("rejects an unknown protocol on either side", () => {
    expect(() =>
      parseModelSwapEnv(JSON.stringify({ ...wellFormed, clientApiShape: "openai-chat" })),
    ).toThrow(/"clientApiShape"/);
    expect(() =>
      parseModelSwapEnv(JSON.stringify({ ...wellFormed, backingApiShape: "openai-chat" })),
    ).toThrow(/"backingApiShape"/);
  });

  it("rejects a known but non-aliasable protocol (url-model)", () => {
    // Every call would be refused anyway — say so at boot instead.
    expect(() =>
      parseModelSwapEnv(JSON.stringify({ ...wellFormed, clientApiShape: "google-generative-ai" })),
    ).toThrow(/"clientApiShape"/);
    expect(() =>
      parseModelSwapEnv(JSON.stringify({ ...wellFormed, backingApiShape: "google-generative-ai" })),
    ).toThrow(/"backingApiShape"/);
  });

  it("rejects the client dialect as a BACKING, at boot", () => {
    // `pi-messages` is what an aliased container speaks INTO the sidecar; the
    // sidecar has no stream to re-originate it against. Refusing it here is the
    // difference between one boot error and one throw per request, deep inside
    // the stream.
    expect(() =>
      parseModelSwapEnv(JSON.stringify({ ...wellFormed, backingApiShape: "pi-messages" })),
    ).toThrow(/"backingApiShape"/);
  });

  it("rejects a vendor protocol as the CLIENT (the container speaks one dialect)", () => {
    for (const shape of ["anthropic-messages", "openai-completions"]) {
      expect(() =>
        parseModelSwapEnv(JSON.stringify({ ...wellFormed, clientApiShape: shape })),
      ).toThrow(/"clientApiShape"/);
    }
  });

  it("rejects a re-origination descriptor with no backing catalog", () => {
    // The pairing that cannot fail open: a boundary that must REBUILD the
    // backing's model record and has nothing to rebuild it from would throw
    // once per request, deep inside the stream, with no stated cause.
    const { backing: _drop, ...rest } = wellFormed;
    expect(() => parseModelSwapEnv(JSON.stringify(rest))).toThrow(/"backing"/);
  });

  it("rejects a re-origination descriptor whose backing catalog is incomplete", () => {
    const base = {
      alias: "appstrate-medium",
      real: "deepseek-chat",
      clientApiShape: "pi-messages" as const,
      backingApiShape: "openai-completions" as const,
    };
    expect(() =>
      parseModelSwapEnv(
        JSON.stringify({ ...base, backing: { reasoning: false, input: ["text"] } }),
      ),
    ).toThrow(/"backing.providerId"/);
    expect(() =>
      parseModelSwapEnv(
        JSON.stringify({ ...base, backing: { providerId: "deepseek", input: ["text"] } }),
      ),
    ).toThrow(/"backing.reasoning"/);
    expect(() =>
      parseModelSwapEnv(
        JSON.stringify({ ...base, backing: { providerId: "deepseek", reasoning: false } }),
      ),
    ).toThrow(/"backing.input"/);
  });

  it("rejects a missing or blank alias / real", () => {
    expect(() =>
      parseModelSwapEnv(
        JSON.stringify({
          real: "deepseek-chat",
          clientApiShape: "pi-messages",
          backingApiShape: "openai-completions",
        }),
      ),
    ).toThrow(/"alias"/);
    expect(() => parseModelSwapEnv(JSON.stringify({ ...wellFormed, real: "   " }))).toThrow(
      /"real"/,
    );
  });

  it("reports malformed JSON instead of crashing with a raw SyntaxError", () => {
    expect(() => parseModelSwapEnv("{not json")).toThrow(/not valid JSON/);
    expect(() => parseModelSwapEnv("[]")).toThrow(/expected a JSON object/);
    expect(() => parseModelSwapEnv("null")).toThrow(/expected a JSON object/);
  });

  it("never names the backing model in any message", () => {
    const cases = [
      JSON.stringify({ alias: "appstrate-medium", real: "deepseek-chat" }),
      JSON.stringify({ ...wellFormed, clientApiShape: "google-generative-ai" }),
      `{"real":"deepseek-chat",`,
    ];
    for (const raw of cases) {
      let message = "";
      try {
        parseModelSwapEnv(raw);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("deepseek");
      expect(message).not.toContain("google");
    }
  });
});
