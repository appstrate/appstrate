// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/model-provider-credentials/discover` — enumerate what an endpoint
 * serves before any credential exists, and prefill each id from the vendored
 * catalog.
 *
 * The invariants under test: the endpoint spends the supplied key exactly once
 * against `GET <base_url>/models`, writes NOTHING (a `credential_id` round must
 * leave `available_model_ids` alone), never returns a per-token cost, and never
 * reads a subscription (OAuth) token. The harness also validates every JSON
 * body against the OpenAPI response schema, so these tests gate the documented
 * shape as well.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";

const app = getTestApp();

/**
 * Synthetic API-key provider that refuses a base URL override. The baseline
 * seeds every module contribution with `baseUrlOverridable: true` so the
 * harness can point them at mock endpoints — so the real `openai` cannot pin
 * the rejection here.
 */
const PINNED_URL_PROVIDER = "test-discover-pinned-url";

function registerPinnedUrlProvider(): void {
  try {
    registerModelProvider({
      providerId: PINNED_URL_PROVIDER,
      displayName: "Test Pinned URL",
      iconUrl: "openai",
      description: "Synthetic api-key provider whose base URL is not overridable.",
      apiShape: "openai-completions",
      defaultBaseUrl: "https://pinned.example.test/v1",
      baseUrlOverridable: false,
      authMode: "api_key",
      featuredModels: [],
    });
  } catch {
    // Already registered in this process — the registry rejects duplicates.
  }
}

/**
 * Stub endpoint, routed by the credential header each wire format sends —
 * `x-api-key` is the Anthropic listing, `Authorization: Bearer` the OpenAI
 * one, so both shapes answer on the one `/v1/models` path the platform builds
 * for them. A wrong key is a 401; `/bad/models` answers a body that is JSON
 * but carries no listing.
 */
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/bad/models") {
      return Response.json({ nope: true });
    }
    if (pathname === "/v1/models") {
      const anthropicKey = req.headers.get("x-api-key");
      if (anthropicKey !== null) {
        if (anthropicKey !== "good-key") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({ data: [{ id: "claude-x", display_name: "Claude X" }] });
      }
      if (req.headers.get("authorization") !== "Bearer good-key") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({ data: [{ id: "gpt-4o" }, { id: "qwen3:8b" }] });
    }
    return new Response("not found", { status: 404 });
  },
});

const GOOD_BASE_URL = `http://127.0.0.1:${stub.port}/v1`;
const BAD_BASE_URL = `http://127.0.0.1:${stub.port}/bad`;
// `anthropic-messages` appends `/v1/models` itself, so its base URL stops at
// the host.
const ANTHROPIC_BASE_URL = `http://127.0.0.1:${stub.port}`;

interface DiscoverModel {
  id: string;
  label: string | null;
  context_window: number | null;
  max_tokens: number | null;
  input: string[] | null;
  reasoning: boolean | null;
}

interface DiscoverBody {
  outcome: string;
  models: DiscoverModel[];
  message: string | null;
}

async function discover(ctx: TestContext, body: unknown): Promise<Response> {
  return app.request("/api/model-provider-credentials/discover", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

async function createCustomCredential(ctx: TestContext, baseUrl: string): Promise<string> {
  const res = await app.request("/api/model-provider-credentials", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      label: "Custom endpoint",
      providerId: "openai-compatible",
      baseUrlOverride: baseUrl,
      apiKey: "good-key",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("POST /api/model-provider-credentials/discover", () => {
  let ctx: TestContext;

  beforeAll(registerPinnedUrlProvider);
  afterAll(() => {
    stub.stop(true);
    // Restore the canonical baseline — `bun test` shares one process and the
    // registry rejects duplicate ids.
    seedTestModelProviders();
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    registerPinnedUrlProvider();
  });

  it("enumerates an inline endpoint and prefills catalog metadata", async () => {
    const res = await discover(ctx, {
      provider_id: "openai-compatible",
      api_key: "good-key",
      base_url_override: GOOD_BASE_URL,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverBody;
    expect(body.outcome).toBe("ok");
    expect(body.message).toBeNull();
    expect(body.models.map((m) => m.id)).toEqual(["gpt-4o", "qwen3:8b"]);

    // `gpt-4o` is a vendored id — the cross-catalog lookup describes it even
    // though `openai-compatible` has no catalog of its own.
    const known = body.models[0]!;
    expect(known.label).toBeString();
    expect(known.context_window).toBeGreaterThan(0);
    expect(known.input).toContain("text");

    // `qwen3:8b` is in no catalog — described as unknown, not guessed.
    expect(body.models[1]).toEqual({
      id: "qwen3:8b",
      label: null,
      context_window: null,
      max_tokens: null,
      input: null,
      reasoning: null,
    });

    // A price carried over from the vendor's catalog would land in the usage
    // ledger as fact — the endpoint must never emit one.
    expect(JSON.stringify(body)).not.toContain("cost");
  });

  it("enumerates an anthropic-messages endpoint over the Anthropic listing shape", async () => {
    const res = await discover(ctx, {
      provider_id: "anthropic-compatible",
      api_key: "good-key",
      base_url_override: ANTHROPIC_BASE_URL,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverBody;
    expect(body.outcome).toBe("ok");
    expect(body.models.map((m) => m.id)).toEqual(["claude-x"]);
  });

  it("reports auth_failed with no models when the endpoint rejects the key", async () => {
    const res = await discover(ctx, {
      provider_id: "openai-compatible",
      api_key: "wrong-key",
      base_url_override: GOOD_BASE_URL,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverBody;
    expect(body.outcome).toBe("auth_failed");
    expect(body.models).toEqual([]);
    expect(body.message).toBeString();
  });

  it("reports bad_response when the body carries no listing", async () => {
    const res = await discover(ctx, {
      provider_id: "openai-compatible",
      api_key: "good-key",
      base_url_override: BAD_BASE_URL,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverBody;
    expect(body.outcome).toBe("bad_response");
    expect(body.models).toEqual([]);
  });

  it("enumerates an existing credential without persisting anything", async () => {
    const id = await createCustomCredential(ctx, GOOD_BASE_URL);
    const [before] = await db
      .select({ ids: modelProviderCredentials.availableModelIds })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));

    const res = await discover(ctx, { credential_id: id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverBody;
    expect(body.outcome).toBe("ok");
    expect(body.models.map((m) => m.id)).toEqual(["gpt-4o", "qwen3:8b"]);

    // Discovery is a read: `refresh-models` is the only writer of this column.
    const [after] = await db
      .select({ ids: modelProviderCredentials.availableModelIds })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));
    expect(after?.ids ?? null).toEqual(before?.ids ?? null);
  });

  it("returns 404 for an unknown credential_id", async () => {
    const res = await discover(ctx, {
      credential_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.status).toBe(404);
  });

  it("refuses an OAuth provider — subscription tokens are never spent on enumeration", async () => {
    const res = await discover(ctx, {
      provider_id: TEST_OAUTH_PROVIDER_ID,
      api_key: "good-key",
    });
    expect(res.status).toBe(400);
  });

  it("refuses an unknown provider_id", async () => {
    const res = await discover(ctx, { provider_id: "not-a-provider", api_key: "good-key" });
    expect(res.status).toBe(400);
  });

  it("refuses both forms at once", async () => {
    const res = await discover(ctx, {
      credential_id: "00000000-0000-0000-0000-000000000000",
      provider_id: "openai-compatible",
      api_key: "good-key",
    });
    expect(res.status).toBe(400);
  });

  it("refuses neither form", async () => {
    const res = await discover(ctx, {});
    expect(res.status).toBe(400);
  });

  it("refuses a base_url_override on a provider that pins its base URL", async () => {
    const res = await discover(ctx, {
      provider_id: PINNED_URL_PROVIDER,
      api_key: "good-key",
      base_url_override: GOOD_BASE_URL,
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 without authentication", async () => {
    const res = await app.request("/api/model-provider-credentials/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "openai-compatible", api_key: "good-key" }),
    });
    expect(res.status).toBe(401);
  });
});
