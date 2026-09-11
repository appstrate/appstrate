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
      // One code is enough HERE: what this file proves is that the inline
      // surface runs `validateAgentIntegrationSelections` at all, in both
      // modes. The gate's per-code verdicts (`scope_not_in_catalog`,
      // `wildcard_not_authorized`, …) are the function's own contract, pinned
      // in `packages/core/test/integration.test.ts`; `scope_not_in_catalog`
      // is also proven on this route below, since the connect-offer mint
      // relies on it upstream.
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

    // ─── WHICH catalog the gate judges against ───────────────
    //
    // An inline run spawns the version its `dependencies.integrations` pin
    // resolves to (`resolveRunIntegrationVersions`), never the integration
    // author's `packages.draft_manifest`. So that pinned version is the catalog
    // these selections must be judged against, and the preflight seeds the
    // memo both this stage and readiness read.
    //
    // Judging the draft is wrong in both directions: a hard 400 `unknown_tool`
    // for a tool the spawned version exposes (the author dropped it from their
    // working copy mid-refactor), and a wave-through for a draft-only tool the
    // spawned version will not register.
    describe("judges the PINNED version, not the author's draft", () => {
      const PINNED = "@inlineorg/pinned-svc";

      /** The same integration at two different tool surfaces. */
      function svcManifest(tools: string[]): Record<string, unknown> {
        return localIntegrationManifest({
          name: PINNED,
          serverName: `${PINNED}-server`,
          version: "1.0.0",
          auths: {
            primary: {
              type: "oauth2",
              authorizationEndpoint: "https://provider.example.com/authorize",
              tokenEndpoint: "https://provider.example.com/token",
              defaultScopes: ["base"],
              scopeCatalog: [{ value: "base", label: "Base" }],
            },
          },
          tools_policy: Object.fromEntries(tools.map((t) => [t, {}])),
        }) as unknown as Record<string, unknown>;
      }

      /** Published 1.0.0 exposes `published_tool`; the live draft exposes only
       *  `draft_only`. Every agent below pins `^1.0.0`. */
      async function seedDivergedIntegration() {
        await seedPackage({
          id: PINNED,
          orgId: ctx.orgId,
          type: "integration",
          source: "local",
          draftManifest: svcManifest(["draft_only"]),
        });
        await seedPackageVersion({
          packageId: PINNED,
          version: "1.0.0",
          manifest: svcManifest(["published_tool"]),
        });
        await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, PINNED);
      }

      function agentSelecting(tools: string[]) {
        return {
          ...validManifest(),
          dependencies: { skills: {}, integrations: { [PINNED]: "^1.0.0" } },
          integrations_configuration: { [PINNED]: { tools } },
        };
      }

      async function errorCodes(res: Response): Promise<Set<string>> {
        const body = (await res.json()) as { errors?: { code: string }[] };
        return new Set(body.errors?.map((e) => e.code));
      }

      it("accepts a tool the PINNED version exposes and the draft dropped", async () => {
        await seedDivergedIntegration();
        const agent = agentSelecting(["published_tool"]);

        // Dry run: the only thing left is the readiness verdict (nothing is
        // connected), never a selection error.
        const validated = await validate(agent);
        expect(validated.status).toBe(400);
        expect([...(await errorCodes(validated))]).toEqual(["not_connected"]);

        // Launch: reaches the 412 the caller can act on, not a hard 400 about a
        // tool the version it would spawn exposes.
        const launched = await launch(agent);
        expect(launched.status).toBe(412);
        expect(((await launched.json()) as { code?: string }).code).toBe(
          "missing_integration_connection",
        );
      });

      it("refuses a tool only the DRAFT exposes, on both routes", async () => {
        // The mirror case, and the control that proves the pinned catalog is
        // what is read: `draft_only` is in the author's working copy, absent
        // from the version this run would spawn.
        await seedDivergedIntegration();
        const agent = agentSelecting(["draft_only"]);
        for (const res of [await validate(agent), await launch(agent)]) {
          expect(res.status).toBe(400);
          const body = (await res.json()) as {
            code?: string;
            errors?: { field: string; code: string }[];
          };
          expect(body.code).toBe("validation_failed");
          const err = body.errors?.find((e) => e.code === "unknown_tool");
          expect(err?.field).toBe(`integrations_configuration.${PINNED}.tools`);
        }
      });
    });
  });
});
