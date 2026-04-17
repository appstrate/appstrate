// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for POST /api/runs/inline.
 *
 * Scope: validation, authentication, and shadow-package persistence.
 * Execution beyond pipeline dispatch (Docker / subprocess adapter) is out
 * of scope — it requires real LLM credentials and a running container
 * runtime, and is covered by the existing classic-run integration tests.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { db } from "../../helpers/db.ts";
import { packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const app = getTestApp();

function validManifest() {
  return {
    name: "@inline/r-ignored", // overridden by the platform
    displayName: "Ad-hoc Agent",
    version: "0.0.0",
    type: "agent",
    description: "Inline run",
    schemaVersion: "1.0.0",
    dependencies: {
      skills: {},
      tools: {},
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

  it("rejects a prompt exceeding the configured char cap with 400", async () => {
    // Default cap is 200_000 chars. Send 200_001.
    const huge = "a".repeat(200_001);
    const res = await post({ manifest: validManifest(), prompt: huge });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/prompt|chars/i);
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
    const manifest = validManifest() as Record<string, unknown>;
    manifest.providers = {
      // A provider entry with a wildcard URI — the default policy forbids this.
      http: { authorizedUris: ["*"] },
    };
    const res = await post({ manifest, prompt: "hi" });
    expect(res.status).toBe(400);
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
