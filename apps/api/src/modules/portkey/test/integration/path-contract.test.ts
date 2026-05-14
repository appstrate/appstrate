// SPDX-License-Identifier: Apache-2.0

/**
 * Portkey routing path contract — empirical SDK-emission test.
 *
 * Bugs in this layer don't surface until a real provider key hits a
 * real LLM call: a stored procedure-style misconfiguration where the
 * gateway baseUrl carries `/v1` but the upstream SDK *also* appends
 * `/v1` produces `/v1/v1/chat/completions` and Portkey 404s. (We hit
 * exactly that with `mistral-conversations` after migrating the API
 * surface to Portkey — pure unit tests passed because they never
 * exercised the SDK's own path convention.)
 *
 * This file pins, per shape:
 *
 *   1. **What the upstream SDK actually appends to its `baseURL`** —
 *      captured empirically by pointing the SDK at an ephemeral
 *      Bun.serve and recording the request path. If a future SDK
 *      upgrade changes the convention, this test fails on the next
 *      `bun test` run.
 *   2. **What the canonical Portkey HTTP surface is for that shape** —
 *      declared as a constant in `PORTKEY_CANONICAL_PATH`.
 *   3. **The composition invariant**: `buildPortkeyRouting(shape)
 *      .baseUrl + sdkEmittedPath` must equal `<gateway>` +
 *      `PORTKEY_CANONICAL_PATH[shape]`. This is the routing math the
 *      sidecar performs in prod (the `/llm/*` reverse-proxy strips
 *      `/llm` and concatenates onto `baseUrl`).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { serve } from "bun";
import { streamMistral } from "@mariozechner/pi-ai/mistral";
import { streamAnthropic } from "@mariozechner/pi-ai/anthropic";
import { streamOpenAICompletions } from "@mariozechner/pi-ai/openai-completions";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import { buildPortkeyRouting } from "../../config.ts";
import {
  listModelProviders,
  registerModelProvider,
  resetModelProviders,
} from "../../../../services/model-providers/registry.ts";

/**
 * Standalone tests don't reach `getTestApp()` (which seeds the registry
 * via `seedTestModelProviders()`), so install minimal fixtures here for
 * the apiShapes this file empirically exercises. One provider per shape
 * is enough — only the `portkeyProvider` slug is consumed by the
 * routing math.
 */
const FIXTURE_PROVIDERS: readonly ModelProviderDefinition[] = [
  {
    providerId: "test-openai",
    displayName: "Test OpenAI",
    iconUrl: "openai",
    apiShape: "openai-completions",
    defaultBaseUrl: "https://api.openai.com/v1",
    baseUrlOverridable: false,
    authMode: "api_key",
    portkeyProvider: "openai",
    models: [],
  },
  {
    providerId: "test-anthropic",
    displayName: "Test Anthropic",
    iconUrl: "anthropic",
    apiShape: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    baseUrlOverridable: false,
    authMode: "api_key",
    portkeyProvider: "anthropic",
    models: [],
  },
  {
    providerId: "test-mistral",
    displayName: "Test Mistral",
    iconUrl: "mistral",
    apiShape: "mistral-conversations",
    defaultBaseUrl: "https://api.mistral.ai",
    baseUrlOverridable: false,
    authMode: "api_key",
    portkeyProvider: "mistral-ai",
    models: [],
  },
];

let restored: readonly ModelProviderDefinition[] = [];
beforeAll(() => {
  restored = listModelProviders();
  resetModelProviders();
  for (const def of FIXTURE_PROVIDERS) registerModelProvider(def);
});
afterAll(() => {
  resetModelProviders();
  for (const def of restored) registerModelProvider(def);
});

/**
 * Canonical Portkey HTTP surface per `apiShape`. Operators reading a
 * 4xx in the routing logs should recognise the path on sight.
 *
 * Coverage is intentionally narrow: only shapes that are exercised
 * end-to-end today (an entry in `INVOKERS` below). Adding a shape
 * means adding an INVOKER, which forces declaring its canonical path
 * (see the declaration guard below).
 */
const PORTKEY_CANONICAL_PATH: Record<string, string> = {
  "openai-completions": "/v1/chat/completions",
  "anthropic-messages": "/v1/messages",
  "mistral-conversations": "/v1/chat/completions",
};

/**
 * Pick one registered providerId per apiShape the empirical test
 * exercises. The shape→providerId mapping is many-to-one for some
 * shapes (e.g. cerebras + groq + xai all share `openai-completions`);
 * for the routing math only the `portkeyProvider` slug matters, so any
 * registered match works. Fails loudly if a shape has no registered
 * provider — that's a regression in the core-providers module.
 */
function pickProviderIdForShape(apiShape: string): string {
  for (const def of listModelProviders()) {
    if (def.apiShape === apiShape && def.portkeyProvider) return def.providerId;
  }
  throw new Error(
    `No registered ModelProviderDefinition with apiShape=${apiShape} and a portkeyProvider slug.`,
  );
}

// Generic preserves the literal `apiShape` so pi-ai's per-shape
// `StreamFunction<"mistral-conversations", …>` typings accept the
// returned model without `as` casts at the call site.
function makeModel<A extends Api>(api: A, provider: string, baseUrl: string, id: string): Model<A> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 64,
  };
}

const CONTEXT: Context = {
  messages: [{ role: "user", content: "ping", timestamp: 0 }],
};

/**
 * For each shape we have a wired pi-ai provider for, fire one streamed
 * request against `baseUrl`. The capture server replies 500 so every
 * SDK aborts immediately — we only care about the path the SDK chose.
 *
 * Adding shapes here is purely additive: the declaration guard below
 * fails any new entry that doesn't have a matching canonical path.
 */
const INVOKERS: Record<string, (baseUrl: string) => void> = {
  "openai-completions": (baseUrl) =>
    drain(
      streamOpenAICompletions(
        makeModel("openai-completions", "openai", baseUrl, "gpt-4o-mini"),
        CONTEXT,
        { apiKey: "test-key" },
      ),
    ),
  "anthropic-messages": (baseUrl) =>
    drain(
      streamAnthropic(
        makeModel("anthropic-messages", "anthropic", baseUrl, "claude-3-5-sonnet-latest"),
        CONTEXT,
        { apiKey: "test-key" },
      ),
    ),
  "mistral-conversations": (baseUrl) =>
    drain(
      streamMistral(
        makeModel("mistral-conversations", "mistral", baseUrl, "mistral-small-latest"),
        CONTEXT,
        { apiKey: "test-key" },
      ),
    ),
};

function drain(stream: AsyncIterable<unknown>): void {
  void (async () => {
    try {
      for await (const _ of stream) {
        // discard
      }
    } catch {
      // SDKs throw on the synthetic 500 — that's the success signal.
    }
  })();
}

async function captureSdkPath(invoke: (baseUrl: string) => void): Promise<{
  path: string;
  stop: () => void;
}> {
  let resolveCaptured!: (path: string) => void;
  const captured = new Promise<string>((r) => (resolveCaptured = r));
  const server = serve({
    port: 0,
    fetch(req) {
      resolveCaptured(new URL(req.url).pathname);
      // 500 with a tiny JSON body — fastest way to make every SDK
      // abort streaming and surface back as a thrown error in the
      // async iterator. We don't care about the error itself.
      return new Response('{"error":"capture-only"}', {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    invoke(`http://127.0.0.1:${server.port}`);
    const path = await Promise.race([
      captured,
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Capture timed out on port ${server.port}`)),
          5_000,
        );
      }),
    ]);
    return { path, stop: () => server.stop(true) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("Portkey routing path contract", () => {
  // Forcing function: every wired invoker MUST have a declared
  // canonical path. Adding `INVOKERS["x"]` without
  // `PORTKEY_CANONICAL_PATH["x"]` fails here.
  for (const shape of Object.keys(INVOKERS)) {
    if (PORTKEY_CANONICAL_PATH[shape] === undefined) {
      it(`${shape}: declares a canonical Portkey path`, () => {
        throw new Error(
          `${shape} has an INVOKERS entry but no PORTKEY_CANONICAL_PATH ` +
            `declaration. Declare the canonical surface so the routing ` +
            `math stays empirically verified.`,
        );
      });
    }
  }

  // Every registered provider that declares `portkeyProvider` must
  // produce a non-null routing tuple. Catches a regression where a
  // provider's slug is dropped or its definition is malformed.
  for (const def of listModelProviders()) {
    if (!def.portkeyProvider) continue;
    it(`${def.providerId}: buildPortkeyRouting returns a non-null tuple`, () => {
      const r = buildPortkeyRouting(
        {
          providerId: def.providerId,
          apiShape: def.apiShape,
          baseUrl: "https://upstream.example",
          apiKey: "k",
        },
        "http://gw.test",
      );
      expect(r).not.toBeNull();
    });
  }

  // Empirical SDK-emission check — the meat of this test file.
  for (const [shape, invoke] of Object.entries(INVOKERS)) {
    const canonical = PORTKEY_CANONICAL_PATH[shape];
    it(`${shape}: routing baseUrl + SDK-emitted path = ${canonical}`, async () => {
      const cap = await captureSdkPath(invoke);
      try {
        const routing = buildPortkeyRouting(
          {
            providerId: pickProviderIdForShape(shape),
            apiShape: shape,
            baseUrl: "https://upstream.example",
            apiKey: "k",
          },
          "http://gw.test",
        );
        expect(routing).not.toBeNull();
        const composed = `${routing!.baseUrl}${cap.path}`;
        expect(composed).toBe(`http://gw.test${canonical}`);
      } finally {
        cap.stop();
      }
    });
  }
});
