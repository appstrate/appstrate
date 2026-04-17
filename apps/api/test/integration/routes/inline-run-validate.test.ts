// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for POST /api/runs/inline/validate — dry-run validator.
 *
 * The validator must:
 *   1. Return 200 { ok: true } on a manifest that /runs/inline would accept.
 *   2. Return 400 with the same error shape on any validation failure.
 *   3. Never insert a shadow row regardless of outcome.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { db } from "../../helpers/db.ts";
import { packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const app = getTestApp();

function validManifest() {
  return {
    name: "@inline/r-ignored",
    displayName: "Ad-hoc Agent",
    version: "0.0.0",
    type: "agent",
    description: "Inline run",
    schemaVersion: "1.0",
    dependencies: { skills: {}, tools: {}, providers: {} },
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

describe("POST /api/runs/inline/validate", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "inlineorg" });
  });

  async function post(body: unknown) {
    return app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function shadowCount() {
    const rows = await db.select().from(packages).where(eq(packages.ephemeral, true));
    return rows.length;
  }

  it("returns 200 { ok: true } on a valid manifest + prompt", async () => {
    const res = await post({ manifest: validManifest(), prompt: "do something" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("does NOT insert a shadow row on success", async () => {
    expect(await shadowCount()).toBe(0);
    const res = await post({ manifest: validManifest(), prompt: "do something" });
    expect(res.status).toBe(200);
    expect(await shadowCount()).toBe(0);
  });

  it("does NOT insert a shadow row on failure", async () => {
    expect(await shadowCount()).toBe(0);
    const res = await post({ manifest: validManifest(), prompt: "" });
    expect(res.status).toBe(400);
    expect(await shadowCount()).toBe(0);
  });

  it("returns 400 with invalid_inline_manifest on a malformed manifest", async () => {
    const res = await post({ manifest: { type: "agent" }, prompt: "hi" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("invalid_inline_manifest");
  });

  it("returns 400 when config fails the manifest's config schema", async () => {
    const manifest = validManifest() as Record<string, unknown>;
    manifest.config = {
      schema: {
        type: "object",
        properties: { maxBullets: { type: "integer", minimum: 1 } },
        required: ["maxBullets"],
      },
    };
    const res = await post({
      manifest,
      prompt: "hi",
      config: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/config/i);
  });

  it("returns 400 when input fails the manifest's input schema", async () => {
    const manifest = validManifest() as Record<string, unknown>;
    manifest.input = {
      schema: {
        type: "object",
        properties: { text: { type: "string", minLength: 5 } },
        required: ["text"],
      },
    };
    const res = await post({
      manifest,
      prompt: "hi",
      input: { text: "no" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/input/i);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Id": ctx.defaultAppId },
      body: JSON.stringify({ manifest: validManifest(), prompt: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  describe("dependency resolution", () => {
    it("accepts a manifest referencing a seeded system tool", async () => {
      await seedPackage({
        id: "@appstrate/output",
        type: "tool",
        source: "system",
        orgId: null,
      });
      const manifest = manifestWithDeps({ tools: { "@appstrate/output": "^1.0.0" } });
      const res = await post({ manifest, prompt: "do something" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("accepts a manifest referencing a seeded org-scoped tool", async () => {
      await seedPackage({
        id: "@inlineorg/mytool",
        type: "tool",
        source: "local",
        orgId: ctx.orgId,
      });
      const manifest = manifestWithDeps({ tools: { "@inlineorg/mytool": "^1.0.0" } });
      const res = await post({ manifest, prompt: "do something" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("returns 400 missing_tool when tool dep is not seeded", async () => {
      const manifest = manifestWithDeps({ tools: { "@fake/nope": "^1.0.0" } });
      const res = await post({ manifest, prompt: "do something" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("missing_tool");
    });

    it("accepts a manifest referencing a seeded org-scoped skill", async () => {
      await seedPackage({
        id: "@inlineorg/helper",
        type: "skill",
        source: "local",
        orgId: ctx.orgId,
      });
      const manifest = manifestWithDeps({ skills: { "@inlineorg/helper": "^1.0.0" } });
      const res = await post({ manifest, prompt: "do something" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("returns 400 missing_skill when skill dep is not seeded", async () => {
      const manifest = manifestWithDeps({ skills: { "@fake/no-skill": "^1.0.0" } });
      const res = await post({ manifest, prompt: "do something" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("missing_skill");
    });

    it("does NOT insert a shadow row after successful dep resolution", async () => {
      await seedPackage({
        id: "@appstrate/output",
        type: "tool",
        source: "system",
        orgId: null,
      });
      const manifest = manifestWithDeps({ tools: { "@appstrate/output": "^1.0.0" } });
      expect(await shadowCount()).toBe(0);
      const res = await post({ manifest, prompt: "do something" });
      expect(res.status).toBe(200);
      expect(await shadowCount()).toBe(0);
    });
  });
});
