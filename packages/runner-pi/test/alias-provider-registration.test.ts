// SPDX-License-Identifier: Apache-2.0

/**
 * An ALIASED run binds its container to {@link ALIAS_PI_PROVIDER_KEY} — a key
 * pi has no builtin for, deliberately, because every key pi DOES know names a
 * vendor.
 *
 * That makes `setPiRuntimeCredential` load-bearing in a way worth pinning
 * behaviorally. `ModelRuntime.setRuntimeApiKey` is only a credential OVERLAY on
 * an existing provider: for an unknown id it stores the key and then recomposes
 * the provider into `models.deleteProvider(...)`. Nothing throws — the failure
 * surfaces one layer away, on the first turn, as `Unknown provider: <id>`. That
 * is a mid-run failure with no boot-time signal, so the door that actually
 * works (`registerProvider`, already used for `openai-codex`) has to be the one
 * this key goes through.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPiRuntimeCredential } from "../src/pi-runner.ts";
import {
  ALIAS_PI_PROVIDER_KEY,
  PI_SDK_VERSION,
  PI_SDK_VERSION_HEADER,
} from "../src/provider-map.ts";
import { SIDECAR_AUTH_HEADER } from "@appstrate/core/sidecar-types";
import { loadPiCodingAgentSdk } from "../src/pi-sdk.ts";
import type { Api, Model } from "../src/pi-sdk.ts";

/** Exactly what `buildPiModelFromEnv` produces for an aliased container. */
const ALIASED_MODEL = {
  id: "appstrate-medium",
  name: "appstrate-medium",
  api: "pi-messages",
  provider: ALIAS_PI_PROVIDER_KEY,
  // The sidecar's `/llm` mount; pi-messages posts `<baseUrl>/messages`.
  baseUrl: "http://127.0.0.1:1/llm",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as Model<Api>;

/** One scratch dir for the file; every runtime gets its own auth file inside it. */
let authRoot: string;
let authSeq = 0;

beforeAll(async () => {
  authRoot = await mkdtemp(join(tmpdir(), "pi-auth-alias-"));
});

afterAll(async () => {
  await rm(authRoot, { recursive: true, force: true });
});

async function newRuntime() {
  const { ModelRuntime } = await loadPiCodingAgentSdk();
  return ModelRuntime.create({
    // Per-test path so a stray write cannot leak between cases.
    authPath: join(authRoot, `auth-${authSeq++}.json`),
    modelsPath: null,
    allowModelNetwork: false,
  });
}

/** Drive one turn against a capturing `fetch` and return the headers pi-ai sent. */
async function sentHeaders(
  runtime: Awaited<ReturnType<typeof newRuntime>>,
  model: Model<Api>,
): Promise<Record<string, string>> {
  let sent: Record<string, string> = {};
  const stream = runtime.stream(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    {
      fetch: ((_url: unknown, init: { headers?: Record<string, string> }) => {
        sent = init.headers ?? {};
        throw new Error("captured");
      }) as unknown as typeof fetch,
    },
  );
  for await (const event of stream) if (event.type === "error") break;
  return sent;
}

/** Drive one turn and return how it terminated (never reaches the network). */
async function firstTurnError(
  runtime: Awaited<ReturnType<typeof newRuntime>>,
): Promise<string | undefined> {
  const stream = runtime.stream(ALIASED_MODEL, {
    messages: [{ role: "user", content: "hi", timestamp: 0 }],
  });
  for await (const event of stream) {
    if (event.type === "error") return event.error.errorMessage;
  }
  return undefined;
}

describe("alias provider key on ModelRuntime", () => {
  it("survives `setPiRuntimeCredential` and reaches the pi-messages transport", async () => {
    const runtime = await newRuntime();
    await setPiRuntimeCredential(runtime, ALIAS_PI_PROVIDER_KEY, "sk-placeholder");
    // The turn still fails — nothing is listening on port 1 — but it fails at
    // the TRANSPORT, which is proof the provider resolved, the credential was
    // found, and pi dispatched to the `pi-messages` implementation.
    const error = await firstTurnError(runtime);
    expect(error).toBeDefined();
    expect(error).not.toContain("Unknown provider");
    expect(error).not.toContain("not configured");
  });

  it("stamps the pi-ai version on the outbound request", async () => {
    // `pi-messages` reads no `Model.headers` (unlike every sibling api), so a
    // provider-config header is the only thing that reaches its wire. Asserted
    // on the bytes: the capturing `fetch` is what pi-ai actually calls.
    const runtime = await newRuntime();
    await setPiRuntimeCredential(runtime, ALIAS_PI_PROVIDER_KEY, "sk-placeholder");
    let sent: Record<string, string> = {};
    const stream = runtime.stream(
      ALIASED_MODEL,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      {
        fetch: ((_url: unknown, init: { headers?: Record<string, string> }) => {
          sent = init.headers ?? {};
          throw new Error("captured");
        }) as unknown as typeof fetch,
      },
    );
    for await (const event of stream) if (event.type === "error") break;
    expect(sent[PI_SDK_VERSION_HEADER]).toBe(PI_SDK_VERSION);
  });

  it("puts `Model.headers` on the wire for an ALIASED run, alongside the provider config", async () => {
    // Load-bearing for the sidecar's agent-auth gate: an aliased container
    // reaches `/llm/*` over `pi-messages`, and the ONLY thing carrying its
    // `SIDECAR_AUTH_HEADER` token there is `Model.headers`, set by
    // `buildPiModelFromEnv`. pi-ai's own `pi-messages` adapter reads
    // `options.headers` only (which is why the version stamp above goes in as
    // provider config) — what closes the gap is `ModelRuntime`'s provider
    // composer, which folds `model.headers` into those options. Asserted on the
    // bytes, because that fold is the SDK's behaviour and not ours.
    const runtime = await newRuntime();
    await setPiRuntimeCredential(runtime, ALIAS_PI_PROVIDER_KEY, "sk-placeholder");
    const sent = await sentHeaders(runtime, {
      ...ALIASED_MODEL,
      headers: { [SIDECAR_AUTH_HEADER]: "alias-run-token" },
    } as unknown as Model<Api>);
    expect(sent[SIDECAR_AUTH_HEADER]).toBe("alias-run-token");
    // The two mechanisms coexist rather than one shadowing the other.
    expect(sent[PI_SDK_VERSION_HEADER]).toBe(PI_SDK_VERSION);

    // Control: a model with no headers sends none, so the line above is about
    // the model record and not about some ambient default.
    const bare = await newRuntime();
    await setPiRuntimeCredential(bare, ALIAS_PI_PROVIDER_KEY, "sk-placeholder");
    expect((await sentHeaders(bare, ALIASED_MODEL))[SIDECAR_AUTH_HEADER]).toBeUndefined();
  });

  it("stamps NOTHING on `openai-codex`, which talks to a real vendor", async () => {
    const runtime = await newRuntime();
    await setPiRuntimeCredential(runtime, "openai-codex", "sk-codex");
    // `auth.headers` is the single junction a provider-config header enters
    // through, so absent here is absent on every request pi originates for it.
    expect((await runtime.getAuth("openai-codex"))?.auth.headers).toBeUndefined();
    await setPiRuntimeCredential(runtime, ALIAS_PI_PROVIDER_KEY, "sk-placeholder");
    expect((await runtime.getAuth(ALIAS_PI_PROVIDER_KEY))?.auth.headers).toEqual({
      [PI_SDK_VERSION_HEADER]: PI_SDK_VERSION,
    });
  });

  it("would NOT survive a bare runtime-key overlay (the trap this avoids)", async () => {
    // The failure mode `setPiRuntimeCredential` exists to prevent, pinned so a
    // future simplification back to a plain `setRuntimeApiKey` fails here
    // rather than on every aliased run.
    const runtime = await newRuntime();
    await runtime.setRuntimeApiKey(ALIAS_PI_PROVIDER_KEY, "sk-placeholder");
    expect(await firstTurnError(runtime)).toContain("Unknown provider");
  });
});
