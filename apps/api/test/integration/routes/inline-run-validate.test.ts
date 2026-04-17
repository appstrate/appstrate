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
    // Accumulate mode wraps every per-stage code under the top-level
    // `validation_failed`. The structural-stage code is preserved on each
    // entry so clients can still branch on it.
    const res = await post({ manifest: { type: "agent" }, prompt: "hi" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code?: string;
      errors?: { code: string }[];
    };
    expect(body.code).toBe("validation_failed");
    expect((body.errors ?? []).some((e) => e.code === "invalid_inline_manifest")).toBe(true);
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

  it("accumulates errors from multiple stages in one response", async () => {
    // Empty prompt + bad config + bad input — three independent stages must
    // all contribute to the errors[] array. This is the entire purpose of
    // accumulate mode: one round-trip, every problem listed.
    const manifest = validManifest() as Record<string, unknown>;
    manifest.config = {
      schema: {
        type: "object",
        properties: { maxBullets: { type: "integer", minimum: 1 } },
        required: ["maxBullets"],
      },
    };
    manifest.input = {
      schema: {
        type: "object",
        properties: { text: { type: "string", minLength: 5 } },
        required: ["text"],
      },
    };

    const res = await post({
      manifest,
      prompt: "",
      config: {},
      input: { text: "no" },
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      code?: string;
      errors?: { field: string; code: string; message: string }[];
    };
    expect(body.code).toBe("validation_failed");
    expect(Array.isArray(body.errors)).toBe(true);

    const fields = (body.errors ?? []).map((e) => e.field);
    // One entry per stage at minimum: prompt, config, input.
    expect(fields.some((f) => f.startsWith("prompt"))).toBe(true);
    expect(fields.some((f) => f.startsWith("config"))).toBe(true);
    expect(fields.some((f) => f.startsWith("input"))).toBe(true);
  });

  it("aggregates structural manifest errors with dep-cap violations", async () => {
    // The manifest is missing `type`, which breaks AFPS dispatch and emits
    // base-schema issues (name/version/type). At the same time the provider
    // deps exceed `max_authorized_uris` — a cap that reads the raw manifest
    // shape and must surface alongside structural errors, not after a short-
    // circuit. This is the regression guard for the fall-through change in
    // `inline-manifest-validation.ts` and `packages/core/validation.ts`.
    const providers: Record<string, string> = {};
    for (let i = 0; i < 200; i++) providers[`@test/provider-${i}`] = "1.0.0";
    const manifest = {
      // `type` intentionally omitted to trigger base-schema aggregation
      name: "@inline/broken",
      version: "0.0.0",
      schemaVersion: "1.0",
      dependencies: { skills: {}, tools: {}, providers },
    };

    const res = await post({ manifest, prompt: "hi" });
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      code?: string;
      errors?: { field: string; code: string; message: string }[];
    };
    expect(body.code).toBe("validation_failed");
    const messages = (body.errors ?? []).map((e) => `${e.field}: ${e.message}`).join("\n");
    // Structural failure surfaces (missing type) AND the dep-cap still fires.
    expect(messages).toMatch(/manifest\.type/i);
    expect(messages).toMatch(/providers.*too many|dependencies\.providers/i);
  });

  it("does not duplicate config errors across preflight stages", async () => {
    // Regression guard: stage 3 (AJV against manifest.config.schema) and
    // stage 4 (agent-readiness) used to both validate config in accumulate
    // mode, producing two entries for the same field under different codes.
    // Readiness now receives { skip: { config: true } }, so a single config
    // violation must appear exactly once in errors[].
    const manifest = validManifest() as Record<string, unknown>;
    manifest.config = {
      schema: {
        type: "object",
        properties: { maxBullets: { type: "integer", minimum: 1 } },
        required: ["maxBullets"],
      },
    };

    const res = await post({ manifest, prompt: "hi", config: {} });
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      errors?: { field: string; code: string; message: string }[];
    };
    const configEntries = (body.errors ?? []).filter((e) => e.field.startsWith("config"));
    expect(configEntries.length).toBe(1);
    // And the remaining code must be the stage-3 one, not the legacy
    // readiness code (`config_incomplete` has been retired in favour of
    // `invalid_config`).
    expect(configEntries[0]!.code).toBe("invalid_config");
  });

  it("does not duplicate prompt errors across preflight stages", async () => {
    // Same regression guard for prompt: stage 1 (manifest structural) flags
    // an empty prompt, readiness used to re-flag it. Now skipped in
    // accumulate mode; only one `prompt`-scoped entry must surface.
    const res = await post({ manifest: validManifest(), prompt: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      errors?: { field: string; code: string; message: string }[];
    };
    const promptEntries = (body.errors ?? []).filter((e) => e.field === "prompt");
    expect(promptEntries.length).toBe(1);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Id": ctx.defaultAppId },
      body: JSON.stringify({ manifest: validManifest(), prompt: "hi" }),
    });
    expect(res.status).toBe(401);
  });
});
