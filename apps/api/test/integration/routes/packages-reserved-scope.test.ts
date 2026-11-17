// SPDX-License-Identifier: Apache-2.0

/**
 * A package id is caller-chosen on the JSON create, the ZIP/GitHub imports and
 * the bundle import, so reserving the org SLUG is not enough: every door that
 * writes an organization package row refuses the platform's scopes —
 * `@appstrate/` (system packages) and `@inline/` (inline runs' shadows) — with
 * `400 scope_reserved`. The GitHub import shares the ZIP import's handler, and
 * both reach the one insert, `createOrgItem`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { and, eq, like } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import {
  buildBundleFromCatalog,
  extractRootFromAfps,
  writeBundleToBuffer,
  type PackageCatalog,
} from "@appstrate/afps-runtime/bundle";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { assertDbMissing } from "../../helpers/assertions.ts";

const app = getTestApp();
const enc = (s: string) => new TextEncoder().encode(s);

const RESERVED_IDS = ["@inline/evil", "@appstrate/evil"] as const;

function agentManifest(id: string, extra: Record<string, unknown> = {}) {
  return {
    name: id,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    display_name: "Squatter",
    description: "Claims a platform scope",
    ...extra,
  };
}

function agentAfps(id: string, extra: Record<string, unknown> = {}): Uint8Array {
  return zipSync({
    "manifest.json": enc(JSON.stringify(agentManifest(id, extra))),
    "prompt.md": enc("You are a squatter."),
  });
}

async function expectScopeReserved(res: Response) {
  expect(res.status, await res.clone().text()).toBe(400);
  const body = (await res.json()) as { code: string; param?: string };
  expect(body.code).toBe("scope_reserved");
  expect(body.param).toBe("manifest.name");
}

describe("organization packages never take a platform scope", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "acme" });
  });

  for (const id of RESERVED_IDS) {
    it(`JSON create refuses ${id}`, async () => {
      const res = await app.request("/api/packages/agents", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ manifest: agentManifest(id), content: "You are a squatter." }),
      });
      await expectScopeReserved(res);
      await assertDbMissing(packages, eq(packages.id, id));
    });

    it(`ZIP import refuses ${id}`, async () => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(agentAfps(id))], "agent.afps"));
      const res = await app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
        body: form,
      });
      await expectScopeReserved(res);
      await assertDbMissing(packages, eq(packages.id, id));
    });

    it(`bundle import refuses ${id} as the root`, async () => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(agentAfps(id))]), "agent.afps");
      const res = await app.request("/api/packages/import-bundle", {
        method: "POST",
        headers: authHeaders(ctx),
        body: form,
      });
      await expectScopeReserved(res);
      await assertDbMissing(packages, eq(packages.id, id));
    });
  }

  it("bundle import refuses a reserved DEPENDENCY before writing any package", async () => {
    const skillId = "@inline/evil-skill";
    const rootId = "@acme/root-agent";
    const skillManifest = {
      name: skillId,
      version: "1.0.0",
      type: "skill",
      schema_version: "0.1",
      display_name: "Evil Skill",
    };
    const identity = `${skillId}@1.0.0` as const;
    const catalog: PackageCatalog = {
      resolve: async (name) => (name === skillId ? { identity } : null),
      fetch: async () => ({
        identity,
        manifest: skillManifest as never,
        files: new Map([
          ["manifest.json", enc(JSON.stringify(skillManifest))],
          ["SKILL.md", enc("---\nname: evil-skill\ndescription: Evil.\n---\nBody.")],
        ]),
        integrity: "sha256-recomputed-by-the-builder",
      }),
    };
    const root = agentAfps(rootId, {
      schema_version: "0.2",
      dependencies: { skills: { [skillId]: "^1.0.0" } },
    });
    const bundle = await buildBundleFromCatalog(extractRootFromAfps(root), catalog, {
      depTypes: ["skills"],
    });

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(writeBundleToBuffer(bundle))]), "b.afps-bundle");
    const res = await app.request("/api/packages/import-bundle", {
      method: "POST",
      headers: authHeaders(ctx),
      body: form,
    });

    await expectScopeReserved(res);
    await assertDbMissing(packages, eq(packages.id, skillId));
    await assertDbMissing(packages, eq(packages.id, rootId));
  });

  // What lets `requireAgentOrInlineRun()` treat every `@inline/` id as a shadow.
  it("leaves no placed, non-ephemeral @inline/ agent for the persistence read to find", async () => {
    await app.request("/api/packages/agents", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        manifest: agentManifest("@inline/evil"),
        content: "You are a squatter.",
      }),
    });

    const rows = await db
      .select({ id: packages.id })
      .from(packages)
      .where(and(like(packages.id, "@inline/%"), eq(packages.ephemeral, false)));
    expect(rows).toEqual([]);

    const res = await app.request("/api/agents/@inline/evil/persistence", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});
