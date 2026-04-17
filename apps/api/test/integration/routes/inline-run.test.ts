// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for POST /api/runs/inline.
 *
 * Scope: validation, authentication, and shadow-package persistence.
 * Execution beyond pipeline dispatch (Docker / subprocess adapter) is out
 * of scope — it requires real LLM credentials and a running container
 * runtime, and is covered by the existing classic-run integration tests.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { db } from "../../helpers/db.ts";
import { packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { resetRateLimiters } from "../../../src/middleware/rate-limit.ts";
import {
  _setRunLimitsForTesting,
  _resetRunLimitsForTesting,
} from "../../../src/services/run-limits.ts";

const app = getTestApp();

function validManifest() {
  return {
    name: "@inline/r-ignored", // overridden by the platform
    displayName: "Ad-hoc Agent",
    version: "0.0.0",
    type: "agent",
    description: "Inline run",
    schemaVersion: "1.0",
    dependencies: {
      skills: {},
      tools: {},
      providers: {},
    },
  };
}

function manifestWithDeps(
  deps: {
    tools?: Record<string, string>;
    skills?: Record<string, string>;
  } = {},
) {
  return {
    ...validManifest(),
    dependencies: {
      skills: deps.skills ?? {},
      tools: deps.tools ?? {},
      providers: {},
    },
  };
}

describe("POST /api/runs/inline — validation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "inlineorg" });
  });

  async function post(body: unknown) {
    return app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a missing prompt with 400", async () => {
    const res = await post({ manifest: validManifest() });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("invalid_inline_manifest");
  });

  it("rejects a missing manifest with 400", async () => {
    const res = await post({ prompt: "do something" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_inline_manifest");
  });

  it("rejects an empty prompt with 400", async () => {
    const res = await post({ manifest: validManifest(), prompt: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a prompt exceeding the configured byte cap with 400", async () => {
    // Default cap is 200_000 bytes. ASCII: 200_001 bytes = 200_001 chars.
    const huge = "a".repeat(200_001);
    const res = await post({ manifest: validManifest(), prompt: huge });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/prompt|bytes/i);
  });

  it("rejects a manifest larger than manifest_bytes with 400", async () => {
    // Default cap is 65536 bytes. Inflate `description` past the cap.
    const manifest = validManifest();
    manifest.description = "x".repeat(70_000);
    const res = await post({ manifest, prompt: "hi" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/manifest|bytes/i);
  });

  it("rejects a manifest with wildcard authorizedUris when wildcard_uri_allowed=false", async () => {
    // Wildcard rejection targets embedded provider definitions
    // (manifest.definition), not the providers dependency map. Use a
    // provider-type inline manifest to exercise the branch.
    const manifest = {
      name: "@inline/r-provider",
      displayName: "Inline Provider",
      version: "0.0.0",
      type: "provider",
      description: "Inline",
      schemaVersion: "1.0",
      definition: {
        authMode: "api_key",
        authorizedUris: ["https://api.example.com", "*"],
        credentials: {
          schema: { type: "object", properties: { apikey: { type: "string" } } },
          fieldName: "apikey",
        },
        credentialHeaderName: "X-Api-Key",
      },
    };
    const res = await post({ manifest, prompt: "hi" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/wildcard/i);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.request("/api/runs/inline", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Id": ctx.defaultAppId },
      body: JSON.stringify({ manifest: validManifest(), prompt: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("does not leak a shadow row when validation fails (400 path)", async () => {
    const countBefore = await db.select().from(packages).where(eq(packages.ephemeral, true));
    expect(countBefore).toHaveLength(0);

    await post({ manifest: validManifest(), prompt: "" });

    const countAfter = await db.select().from(packages).where(eq(packages.ephemeral, true));
    expect(countAfter).toHaveLength(0);
  });
});

describe("POST /api/runs/inline — dependency resolution", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "inlineorg" });
  });

  async function post(body: unknown) {
    return app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("resolves a seeded system tool past the readiness check", async () => {
    await seedPackage({
      id: "@appstrate/output",
      type: "tool",
      source: "system",
      orgId: null,
    });
    const manifest = manifestWithDeps({ tools: { "@appstrate/output": "^1.0.0" } });
    const res = await post({ manifest, prompt: "do something" });
    // Readiness cleared → the route accepts the run and returns 202 with a
    // { runId, packageId } payload. Asserting the full success shape
    // (rather than a loose "not missing_tool") locks in the fix end-to-end
    // and catches any regression that would reintroduce a rejection.
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId?: string; packageId?: string };
    expect(body.runId).toMatch(/^run_/);
    expect(body.packageId).toMatch(/^@inline\//);
  });

  it("returns 400 missing_tool when tool dep is bogus", async () => {
    const manifest = manifestWithDeps({ tools: { "@fake/nope": "^1.0.0" } });
    const res = await post({ manifest, prompt: "do something" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("missing_tool");
  });
});

describe("POST /api/runs/inline — rate limiting", () => {
  // rate_per_min is captured at route-build time (closure over
  // getInlineRunLimits()). We install a low cap BEFORE building an explicit
  // app instance so this suite exercises 429 without affecting the default
  // cached app used by other suites.
  let ctx: TestContext;
  let limitedApp: ReturnType<typeof getTestApp>;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetRateLimiters();
    _resetRunLimitsForTesting();
    _setRunLimitsForTesting({}, { rate_per_min: 2 });
    limitedApp = getTestApp({ modules: [] });
    ctx = await createTestContext({ orgSlug: "inlineratelimit" });
  });

  afterAll(() => {
    resetRateLimiters();
    // Restore defaults so other test files relying on getInlineRunLimits()
    // at request time (e.g. compaction worker, run-pipeline) don't see null.
    _setRunLimitsForTesting({}, {});
  });

  it("returns 429 once rate_per_min is exceeded", async () => {
    const body = JSON.stringify({ manifest: validManifest(), prompt: "hi" });
    const headers = { ...authHeaders(ctx), "Content-Type": "application/json" };

    // First two requests consume the quota. Status doesn't matter here —
    // whatever the outcome (validation pass or fail, 202 or 500), the
    // rate-limit middleware has already decremented the bucket.
    await limitedApp.request("/api/runs/inline", { method: "POST", headers, body });
    await limitedApp.request("/api/runs/inline", { method: "POST", headers, body });

    // Third call must be rejected before reaching the handler.
    const res = await limitedApp.request("/api/runs/inline", { method: "POST", headers, body });
    expect(res.status).toBe(429);
    expect(res.headers.get("RateLimit")).toMatch(/remaining=0/);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});
