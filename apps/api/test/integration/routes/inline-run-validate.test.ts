// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for POST /api/runs/inline/validate — dry-run validator.
 *
 * The validator must:
 *   1. Return 200 { valid: true } on a manifest that /runs/inline would accept.
 *   2. Return 400 with the same error shape on any validation failure.
 *   3. Never insert a shadow row regardless of outcome.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { db } from "../../helpers/db.ts";
import { packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { installPackage } from "../../../src/services/space-packages.ts";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";

const app = getTestApp();

function validManifest() {
  return {
    name: "@inline/r-ignored",
    display_name: "Ad-hoc Agent",
    version: "0.0.0",
    type: "agent",
    description: "Inline run",
    schema_version: "0.1",
    dependencies: { skills: {} },
  };
}

function manifestWithDeps(
  deps: {
    skills?: Record<string, string>;
  } = {},
) {
  return {
    ...validManifest(),
    dependencies: {
      skills: deps.skills ?? {},
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

  it("returns 200 { valid: true } on a valid manifest + prompt", async () => {
    const res = await post({ manifest: validManifest(), prompt: "do something" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  it("accepts a manifest with no display_name (defaulted from name)", async () => {
    // display_name is AFPS-required but pure ceremony for an ephemeral inline
    // agent — the preflight defaults it from `name` so callers (e.g. an LLM
    // assembling the manifest) never trigger a needless retry for it.
    const { display_name: _omit, ...noDisplayName } = validManifest();
    const res = await post({ manifest: noDisplayName, prompt: "do something" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { valid: boolean }).valid).toBe(true);
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
    // Empty prompt + bad input — two independent stages must both contribute
    // to the errors[] array. This is the entire purpose of accumulate mode:
    // one round-trip, every problem listed.
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
      prompt: "",
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
    // One entry per stage at minimum: prompt, input.
    expect(fields.some((f) => f.startsWith("prompt"))).toBe(true);
    expect(fields.some((f) => f.startsWith("input"))).toBe(true);
  });

  it("aggregates structural manifest errors with dep-cap violations", async () => {
    // The manifest is missing `type`, which breaks AFPS dispatch and emits
    // base-schema issues (name/version/type). At the same time the skill
    // deps exceed `max_skills` — a cap that reads the raw manifest shape and
    // must surface alongside structural errors, not after a short-circuit.
    // This is the regression guard for the fall-through change in
    // `inline-manifest-validation.ts` and `packages/core/validation.ts`.
    const skills: Record<string, string> = {};
    for (let i = 0; i < 200; i++) skills[`@test/skill-${i}`] = "1.0.0";
    const manifest = {
      // `type` intentionally omitted to trigger base-schema aggregation
      name: "@inline/broken",
      version: "0.0.0",
      schema_version: "0.1",
      dependencies: { skills },
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
    expect(messages).toMatch(/skills.*too many|dependencies\.skills/i);
  });

  it("does not duplicate input errors across preflight stages", async () => {
    // Regression guard: input is validated by exactly ONE stage (AJV against
    // `manifest.input.schema`). Readiness has no notion of run input, so a
    // single violation must appear exactly once in errors[].
    const manifest = validManifest() as Record<string, unknown>;
    manifest.input = {
      schema: {
        type: "object",
        properties: { maxBullets: { type: "integer", minimum: 1 } },
        required: ["maxBullets"],
      },
    };

    const res = await post({ manifest, prompt: "hi", input: {} });
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      errors?: { field: string; code: string; message: string }[];
    };
    const inputEntries = (body.errors ?? []).filter((e) => e.field.startsWith("input"));
    expect(inputEntries.length).toBe(1);
    expect(inputEntries[0]!.code).toBe("invalid_input");
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
      headers: { "Content-Type": "application/json", "X-Space-Id": ctx.defaultSpaceId },
      body: JSON.stringify({ manifest: validManifest(), prompt: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  describe("dependency resolution", () => {
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
      const body = (await res.json()) as { valid: boolean };
      expect(body.valid).toBe(true);
    });

    it("returns 400 missing_skill when skill dep is not seeded", async () => {
      const manifest = manifestWithDeps({ skills: { "@fake/no-skill": "^1.0.0" } });
      const res = await post({ manifest, prompt: "do something" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        code?: string;
        errors?: { field: string; code: string }[];
      };
      expect(body.code).toBe("validation_failed");
      expect(body.errors?.some((e) => e.code === "missing_skill")).toBe(true);
    });

    it("does NOT insert a shadow row after successful dep resolution", async () => {
      await seedPackage({
        id: "@inlineorg/helper2",
        type: "skill",
        source: "local",
        orgId: ctx.orgId,
      });
      const manifest = manifestWithDeps({ skills: { "@inlineorg/helper2": "^1.0.0" } });
      expect(await shadowCount()).toBe(0);
      const res = await post({ manifest, prompt: "do something" });
      expect(res.status).toBe(200);
      expect(await shadowCount()).toBe(0);
    });
  });

  // ─── Integration tool/scope selections (#1207) ───────────
  //
  // The inline surface is the ONE place an agent manifest arrives in the
  // request body, so it is the one place `integrations_configuration[id]
  // .{tools,scopes}` was never checked against the integration's catalog —
  // publish and import both run `validateAgentIntegrationSelections`. That is a
  // security boundary, not just legibility: the readiness gate derives an
  // item's `required_scopes` from these selections and the connect-offer relay
  // signs a consent request from them.
  describe("integrations_configuration subset gate", () => {
    const INTEGRATION = "@inlineorg/scoped-svc";

    function integrationManifest() {
      return localIntegrationManifest({
        name: INTEGRATION,
        serverName: `${INTEGRATION}-server`,
        version: "1.0.0",
        auths: {
          primary: {
            type: "oauth2",
            authorizationEndpoint: "https://provider.example.com/authorize",
            tokenEndpoint: "https://provider.example.com/token",
            defaultScopes: ["base"],
            scopeCatalog: [
              { value: "base", label: "Base" },
              { value: "search.read", label: "Search" },
            ],
          },
        },
        tools_policy: { search: { required_scopes: { primary: ["search.read"] } } },
      });
    }

    async function seedIntegration() {
      const manifest = integrationManifest() as unknown as Record<string, unknown>;
      await seedPackage({
        id: INTEGRATION,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        draftManifest: manifest,
      });
      await seedPackageVersion({ packageId: INTEGRATION, version: "1.0.0", manifest });
      await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);
    }

    function manifestSelecting(selection: Record<string, unknown>) {
      return {
        ...validManifest(),
        dependencies: { skills: {}, integrations: { [INTEGRATION]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: selection },
      };
    }

    /** The dry-run route — accumulate mode. */
    async function validate(manifest: unknown) {
      return post({ manifest, prompt: "do something" });
    }

    /** The launch route — fail-fast mode, where a bad selection must not run. */
    async function launch(manifest: unknown) {
      return app.request("/api/runs/inline", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ manifest, prompt: "do something" }),
      });
    }

    it("refuses a tool the integration does not expose, on BOTH routes", async () => {
      await seedIntegration();
      for (const res of [
        await validate(manifestSelecting({ tools: ["exfiltrate"] })),
        await launch(manifestSelecting({ tools: ["exfiltrate"] })),
      ]) {
        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          code?: string;
          errors?: { field: string; code: string }[];
        };
        expect(body.code).toBe("validation_failed");
        const err = body.errors?.find((e) => e.code === "unknown_tool");
        expect(err?.field).toBe(`integrations_configuration.${INTEGRATION}.tools`);
      }
    });

    it("refuses a scope outside the integration's scope_catalog", async () => {
      // The one that matters most: `scopes` is what the readiness 412 relays as
      // `required_scopes`, and what a minted connect link would ask consent for.
      await seedIntegration();
      const res = await validate(manifestSelecting({ tools: ["search"], scopes: ["mail.send"] }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { field: string; code: string }[] };
      const err = body.errors?.find((e) => e.code === "scope_not_in_catalog");
      expect(err?.field).toBe(`integrations_configuration.${INTEGRATION}.scopes`);
    });

    it("refuses the wildcard when the integration did not authorize it", async () => {
      await seedIntegration();
      const res = await validate(manifestSelecting({ tools: "*" }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { field: string; code: string }[] };
      const err = body.errors?.find((e) => e.code === "wildcard_not_authorized");
      expect(err?.field).toBe(`integrations_configuration.${INTEGRATION}.tools`);
    });

    it("accumulates alongside the other stages on /validate", async () => {
      // The whole point of the dry-run route: one round trip, every problem.
      await seedIntegration();
      const manifest = {
        ...manifestSelecting({ tools: ["exfiltrate"], scopes: ["mail.send"] }),
        dependencies: {
          skills: { "@fake/no-skill": "^1.0.0" },
          integrations: { [INTEGRATION]: "^1.0.0" },
        },
      };
      const res = await validate(manifest);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { code: string }[] };
      const codes = new Set(body.errors?.map((e) => e.code));
      expect(codes.has("unknown_tool")).toBe(true);
      expect(codes.has("scope_not_in_catalog")).toBe(true);
      expect(codes.has("missing_skill")).toBe(true);
    });

    it("raises no selection error when the catalog declares everything picked", async () => {
      // Discriminating control: the gate refuses what is OUTSIDE the catalog,
      // not every manifest that names an integration. What remains is the
      // readiness verdict — no connection was seeded — and its `required_scopes`
      // is the selection relayed verbatim, which is exactly the value the
      // connect kickoff will accept.
      await seedIntegration();
      const res = await validate(manifestSelecting({ tools: ["search"], scopes: ["search.read"] }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        errors?: { code: string; required_scopes?: string[] }[];
      };
      expect(body.errors?.map((e) => e.code)).toEqual(["not_connected"]);
      expect(body.errors?.[0]?.required_scopes).toEqual(["search.read"]);
    });

    it("does NOT insert a shadow row when the selection is refused", async () => {
      await seedIntegration();
      expect(await shadowCount()).toBe(0);
      expect((await launch(manifestSelecting({ tools: ["exfiltrate"] }))).status).toBe(400);
      expect(await shadowCount()).toBe(0);
    });
  });
});
