// SPDX-License-Identifier: Apache-2.0

/**
 * Author-time visibility of the platform timeout ceiling.
 *
 * `runPreflightGates` has always clamped a declared `timeout` to
 * `PLATFORM_RUN_LIMITS.timeout_ceiling_seconds`, but silently: an agent
 * declaring 10800 got 1800 with no signal anywhere in the API. These tests pin
 * the two places the author can now find out — the non-blocking `warnings`
 * array on the import 201, and `effective_timeout_seconds` on the agent detail.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { zipSync } from "fflate";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/space-packages.ts";
import { _setRunLimitsForTesting } from "../../../src/services/run-limits.ts";

const app = getTestApp();

// Concrete ceiling rather than the 1800 default: a test that passes only
// because it happens to match the default would keep passing if the resolver
// stopped reading the registry at all.
const CEILING = 900;

function agentAfps(name: string, manifestExtras: Record<string, unknown>): File {
  const enc = (s: string) => new TextEncoder().encode(s);
  const afps = zipSync({
    "manifest.json": enc(
      JSON.stringify({
        name: `@ceilingorg/${name}`,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: name,
        ...manifestExtras,
      }),
    ),
    "prompt.md": enc("You are an agent."),
  });
  return new File([new Uint8Array(afps)], `${name}.afps`);
}

describe("platform timeout ceiling — author-time visibility", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "ceiling@test.dev", orgSlug: "ceilingorg" });
    _setRunLimitsForTesting({ timeout_ceiling_seconds: CEILING }, {});
  });

  // `bun test` shares one process — hand the documented defaults back so the
  // next file reads the limits `helpers/app.ts` installed at import time.
  afterAll(() => {
    _setRunLimitsForTesting({}, {});
  });

  describe("POST /api/packages/import", () => {
    async function importAgent(name: string, extras: Record<string, unknown>): Promise<Response> {
      const formData = new FormData();
      formData.append("file", agentAfps(name, extras));
      return app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
        body: formData,
      });
    }

    it("warns (non-blocking) when the declared timeout exceeds the ceiling", async () => {
      const res = await importAgent("over-ceiling", { timeout: 10800 });

      // Still a 201 — the ceiling is deployment-specific, so a manifest above
      // THIS deployment's ceiling stays importable.
      expect(res.status).toBe(201);
      const body = (await res.json()) as { packageId: string; warnings?: string[] };
      expect(body.packageId).toBe("@ceilingorg/over-ceiling");
      expect(body.warnings).toEqual([
        `timeout: declared 10800s exceeds this deployment's ceiling — runs will be capped at ${CEILING}s.`,
      ]);
    });

    it("emits no warnings channel when the declared timeout is below the ceiling", async () => {
      const res = await importAgent("under-ceiling", { timeout: 60 });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { warnings?: string[] };
      // The route omits the key entirely when nothing warned.
      expect(body.warnings).toBeUndefined();
    });

    it("emits no warning for a non-agent manifest (no run timeout exists)", async () => {
      const enc = (s: string) => new TextEncoder().encode(s);
      const afps = zipSync({
        "manifest.json": enc(
          JSON.stringify({
            name: "@ceilingorg/ceiling-skill",
            version: "1.0.0",
            type: "skill",
            schema_version: "0.1",
            display_name: "Ceiling Skill",
            // A `timeout` on a skill is meaningless — and must not warn.
            timeout: 10800,
          }),
        ),
        "SKILL.md": enc(
          "---\nname: ceiling-skill\ndescription: A ceiling skill.\n---\n\nSkill body.",
        ),
      });
      const formData = new FormData();
      formData.append("file", new File([new Uint8Array(afps)], "skill.afps"));

      const res = await app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
        body: formData,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { warnings?: string[] };
      expect(body.warnings).toBeUndefined();
    });
  });

  describe("GET /api/packages/agents/{scope}/{name}", () => {
    async function detailFor(id: string): Promise<any> {
      await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id);
      const res = await app.request(`/api/packages/agents/${id}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      return res.json();
    }

    it("reports the declared value when it is below the ceiling", async () => {
      await seedAgent({
        id: "@ceilingorg/detail-under",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@ceilingorg/detail-under",
          version: "0.1.0",
          type: "agent",
          timeout: 120,
        },
      });
      const body = await detailFor("@ceilingorg/detail-under");
      expect(body.effective_timeout_seconds).toBe(120);
      expect(body.manifest.timeout).toBe(120);
    });

    it("reports the ceiling when the declared value is above it", async () => {
      await seedAgent({
        id: "@ceilingorg/detail-over",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@ceilingorg/detail-over",
          version: "0.1.0",
          type: "agent",
          timeout: 10800,
        },
      });
      const body = await detailFor("@ceilingorg/detail-over");
      expect(body.effective_timeout_seconds).toBe(CEILING);
      // The declared value stays visible — the pair is what makes the cap
      // legible to the dashboard.
      expect(body.manifest.timeout).toBe(10800);
    });

    it("reports the platform default when the manifest declares no timeout", async () => {
      await seedAgent({
        id: "@ceilingorg/detail-none",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const body = await detailFor("@ceilingorg/detail-none");
      expect(body.effective_timeout_seconds).toBe(300);
      expect(body.manifest.timeout).toBeUndefined();
    });
  });
});
