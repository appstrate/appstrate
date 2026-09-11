// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/model-provider-credentials/discover` — enumerate what an endpoint
 * serves before any credential exists, and prefill each id from the vendored
 * catalog.
 *
 * The invariants under test: the endpoint spends the supplied key on
 * `GET <base_url>/models` and on nothing else — once for a listing that fits in
 * one page, once more per page a paginated listing declares — writes NOTHING (a
 * `credential_id` round must
 * leave `available_model_ids` alone), never returns a per-token cost, and never
 * reads a subscription (OAuth) token. The harness also validates every JSON
 * body against the OpenAPI response schema, so these tests gate the documented
 * shape as well.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, auditEvents } from "@appstrate/db/schema";
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

/**
 * Synthetic api-key provider that declares a static model list. `modelDiscovery:
 * { mode: "static" }` is what keeps a credential off the listing path — no
 * shipped provider is in this shape today (both static providers are oauth2),
 * so only a synthetic one can pin that the gate reads the declaration and not
 * the auth mode.
 */
const STATIC_LIST_PROVIDER = "test-discover-static-list";

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
  try {
    registerModelProvider({
      providerId: STATIC_LIST_PROVIDER,
      displayName: "Test Static List",
      iconUrl: "openai",
      description: "Synthetic api-key provider whose served set is declared, not enumerated.",
      apiShape: "openai-completions",
      defaultBaseUrl: "https://static.example.test/v1",
      baseUrlOverridable: true,
      authMode: "api_key",
      featuredModels: [],
      modelDiscovery: { mode: "static" },
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
/** Listing requests the stub served, per credential — pagination must not spend more than it needs. */
const listingRequests = new Map<string, number>();

function countRequest(key: string): void {
  listingRequests.set(key, (listingRequests.get(key) ?? 0) + 1);
}

const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === "/bad/models") {
      return Response.json({ nope: true });
    }
    // Gemini's listing: keyed by query parameter, paged by `nextPageToken`.
    if (pathname === "/gemini/models") {
      countRequest("gemini");
      const token = searchParams.get("pageToken");
      if (token === null) {
        return Response.json({
          models: [{ name: "models/gemini-page1" }],
          nextPageToken: "tok-2",
        });
      }
      if (token === "tok-2") {
        return Response.json({ models: [{ name: "models/gemini-page2" }] });
      }
      return Response.json({ models: [] });
    }
    if (pathname === "/v1/models") {
      const anthropicKey = req.headers.get("x-api-key");
      if (anthropicKey !== null) {
        if (anthropicKey !== "good-key" && anthropicKey !== "paged-key") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (anthropicKey === "good-key") {
          countRequest("anthropic");
          return Response.json({ data: [{ id: "claude-x", display_name: "Claude X" }] });
        }
        // The Anthropic listing pages at 20 entries: `has_more` + `last_id`,
        // spent as `after_id`. Two entries per page is the same protocol.
        countRequest("paged");
        const after = searchParams.get("after_id");
        if (after === null) {
          return Response.json({
            data: [{ id: "claude-a" }, { id: "claude-b" }],
            has_more: true,
            first_id: "claude-a",
            last_id: "claude-b",
          });
        }
        if (after === "claude-b") {
          return Response.json({
            data: [{ id: "claude-c" }],
            has_more: false,
            first_id: "claude-c",
            last_id: "claude-c",
          });
        }
        return Response.json({ data: [], has_more: false });
      }
      // A server that publishes per-entry capability fields (vLLM's
      // `max_model_len`), routed by its own key so the catalog-only case above
      // stays untouched.
      if (req.headers.get("authorization") === "Bearer hints-key") {
        return Response.json({
          data: [{ id: "local-llm", max_model_len: 32768 }, { id: "gpt-4o" }],
        });
      }
      // An endpoint whose listing is WELL-FORMED and enormous: ~6 MB of valid
      // JSON, chunked so no `content-length` declares it. Parsing it would
      // succeed — only a byte budget on the read refuses it.
      if (req.headers.get("authorization") === "Bearer flood-key") {
        countRequest("flood");
        const encoder = new TextEncoder();
        const padding = "p".repeat(4_096);
        let sent = 0;
        let index = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent === 0) {
                controller.enqueue(encoder.encode('{"data":['));
              }
              if (sent >= 6 * 1024 * 1024) {
                controller.enqueue(encoder.encode("]}"));
                controller.close();
                return;
              }
              const entry = encoder.encode(
                `${index === 0 ? "" : ","}{"id":"flood-${index}","note":"${padding}"}`,
              );
              index += 1;
              sent += entry.byteLength;
              controller.enqueue(entry);
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      // An endpoint whose cursor never ends — the page cap has to stop it.
      if (req.headers.get("authorization") === "Bearer endless-key") {
        countRequest("endless");
        const after = searchParams.get("after_id");
        const next = after === null ? 1 : Number(after.split("-")[1]) + 1;
        return Response.json({
          data: [{ id: `endless-${next}` }],
          has_more: true,
          last_id: `endless-${next}`,
        });
      }
      if (req.headers.get("authorization") !== "Bearer good-key") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      countRequest("openai");
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
const GEMINI_BASE_URL = `http://127.0.0.1:${stub.port}/gemini`;

interface DiscoverModel {
  id: string;
  label: string | null;
  context_window: number | null;
  max_tokens: number | null;
  input: string[] | null;
  reasoning: boolean | null;
  source: "endpoint" | "catalog" | null;
}

interface DiscoverBody {
  outcome: string;
  models: DiscoverModel[];
  truncated: boolean;
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
    listingRequests.clear();
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

    // One page, one request — and the caller is told the list is complete.
    expect(body.truncated).toBe(false);
    expect(listingRequests.get("openai")).toBe(1);

    // `gpt-4o` is a vendored id — the cross-catalog lookup describes it even
    // though `openai-compatible` has no catalog of its own.
    const known = body.models[0]!;
    expect(known.label).toBeString();
    expect(known.context_window).toBeGreaterThan(0);
    expect(known.input).toContain("text");

    expect(known.source).toBe("catalog");

    // `qwen3:8b` is in no catalog and the endpoint published nothing about it
    // — described as unknown, not guessed.
    expect(body.models[1]).toEqual({
      id: "qwen3:8b",
      label: null,
      context_window: null,
      max_tokens: null,
      input: null,
      reasoning: null,
      source: null,
    });

    // A price carried over from the vendor's catalog would land in the usage
    // ledger as fact — the endpoint must never emit one.
    expect(JSON.stringify(body)).not.toContain("cost");
  });

  it("reads the capability fields the listing publishes, per model", async () => {
    const res = await discover(ctx, {
      provider_id: "openai-compatible",
      api_key: "hints-key",
      base_url_override: GOOD_BASE_URL,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverBody;
    expect(body.outcome).toBe("ok");

    // In no catalog, yet described — the endpoint published its own context
    // window and nothing else was requested to learn it.
    const local = body.models[0]!;
    expect(local.id).toBe("local-llm");
    expect(local.context_window).toBe(32768);
    expect(local.source).toBe("endpoint");
    expect(local.label).toBeNull();

    // The same listing describes nothing about `gpt-4o`, so the catalog still
    // does — the hint path must not blank out what was already known.
    const known = body.models[1]!;
    expect(known.id).toBe("gpt-4o");
    expect(known.context_window).toBeGreaterThan(0);
    expect(known.source).toBe("catalog");
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

  it("follows the listing cursor instead of returning a silently short first page", async () => {
    const res = await discover(ctx, {
      provider_id: "anthropic-compatible",
      api_key: "paged-key",
      base_url_override: ANTHROPIC_BASE_URL,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverBody;
    expect(body.outcome).toBe("ok");
    // Page two exists only because `has_more` was followed — one fetch would
    // have reported success with `claude-c` missing.
    expect(body.models.map((m) => m.id)).toEqual(["claude-a", "claude-b", "claude-c"]);
    expect(body.truncated).toBe(false);
    // Two pages, two requests: the last page declares `has_more: false`, so
    // nothing is spent asking for a third.
    expect(listingRequests.get("paged")).toBe(2);
  });

  it("follows the Google listing's nextPageToken", async () => {
    const res = await discover(ctx, {
      provider_id: "google-ai",
      api_key: "good-key",
      base_url_override: GEMINI_BASE_URL,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverBody;
    expect(body.outcome).toBe("ok");
    expect(body.models.map((m) => m.id)).toEqual(["gemini-page1", "gemini-page2"]);
    expect(body.truncated).toBe(false);
    expect(listingRequests.get("gemini")).toBe(2);
  });

  it("reports truncated when a cursor that never ends hits the page cap", async () => {
    const res = await discover(ctx, {
      provider_id: "openai-compatible",
      api_key: "endless-key",
      base_url_override: GOOD_BASE_URL,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverBody;
    expect(body.outcome).toBe("ok");
    // Success, but declared short — the operator is not told this is the whole
    // list. The cap bounds the requests spent on one call.
    expect(body.truncated).toBe(true);
    expect(listingRequests.get("endless")).toBe(10);
    expect(body.models).toHaveLength(10);
  });

  it("refuses a listing whose body streams past the size budget", async () => {
    const res = await discover(ctx, {
      provider_id: "openai-compatible",
      api_key: "flood-key",
      base_url_override: GOOD_BASE_URL,
    });

    // The endpoint never stops sending; the read stops it. Without a byte
    // budget the whole payload lands in the API process before it is parsed.
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiscoverBody;
    expect(body.outcome).toBe("bad_response");
    expect(body.models).toEqual([]);
    expect(listingRequests.get("flood")).toBe(1);
  });

  it("refuses an api-key provider that declares a static model list", async () => {
    const res = await discover(ctx, {
      provider_id: STATIC_LIST_PROVIDER,
      api_key: "good-key",
      base_url_override: GOOD_BASE_URL,
    });

    // The declaration is what gates enumeration, not the auth mode: this
    // provider authenticates with an api key and must still not be listed.
    expect(res.status).toBe(400);
    expect(listingRequests.get("openai")).toBeUndefined();
  });

  it("records the probe in the audit trail, without the key", async () => {
    const res = await discover(ctx, {
      provider_id: "openai-compatible",
      api_key: "good-key",
      base_url_override: GOOD_BASE_URL,
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select({
        action: auditEvents.action,
        resourceType: auditEvents.resourceType,
        resourceId: auditEvents.resourceId,
        after: auditEvents.after,
      })
      .from(auditEvents)
      .where(eq(auditEvents.action, "model_provider_credential.discovered"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("model_provider_credential.discovered");
    expect(row.resourceType).toBe("model_provider_credential");
    // No credential exists on the inline form — the trail still names the
    // endpoint that was reached and what came back.
    expect(row.resourceId).toBeNull();
    expect(row.after).toMatchObject({
      providerId: "openai-compatible",
      baseUrl: GOOD_BASE_URL,
      outcome: "ok",
      modelCount: 2,
      truncated: false,
    });
    expect(JSON.stringify(row.after)).not.toContain("good-key");
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
