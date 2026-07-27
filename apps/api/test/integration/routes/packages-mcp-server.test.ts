// SPDX-License-Identifier: Apache-2.0

/**
 * First-class `mcp-server` package routes (AFPS §3.4).
 *
 * An `mcp-server` package's `manifest.json` is AFPS-native at the root with
 * MCPB-vocabulary fields embedded — the AFPS identity contract
 * (`type: "mcp-server"`, scoped `name`, `schema_version`, `dependencies`) is
 * lifted to the manifest root alongside MCPB-vocabulary fields (`server`,
 * `tools`, `user_config`) in AFPS §3.4 / §11.2. They are import-only
 * (no editor), but otherwise have full parity with the other
 * package types: importable via `POST /api/packages/import`, listable via
 * `GET /api/packages/mcp-servers`, and fetchable via
 * `GET /api/packages/mcp-servers/{scope}/{name}`.
 *
 * Covers:
 *   1. IMPORT — a minimal valid mcp-server `.afps` creates the package row with
 *      type "mcp-server", stores files under mcp-servers/, and creates a version.
 *   2. LIST — the imported server appears in GET /api/packages/mcp-servers.
 *   3. GET   — the server detail is fetchable by scope/name.
 *   4. Auth boundary on list + get.
 *   5. CREATE (`POST /api/packages/mcp-servers`) — the manifest gate of issue
 *      #987. This is the only route family reaching `parsePackageUpload`
 *      (`jsonBodyCreate: false`), which used to let a manifest through
 *      unvalidated (absent / malformed `manifest.json`, absent JSON-body
 *      `manifest`) and then let `createOrgItem` rewrite `type` after
 *      validation — both landing a manifest no AFPS schema accepts in the
 *      IMMUTABLE `package_versions.manifest` row.
 *   6. UPDATE (`PUT`) — the author/stored direction asymmetry that gate rests on.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { mcpServerManifest } from "../../helpers/integration-manifests.ts";
import { packages, packageVersions } from "@appstrate/db/schema";
import { validateManifest } from "@appstrate/core/validation";
import { eq } from "drizzle-orm";

const app = getTestApp();

const SERVER_ID = "@pkgorg/my-mcp-server";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Build a minimal valid mcp-server `.afps` ZIP. AFPS (§3.4) lifted the
 * mcp-server identity to the manifest root, so `manifest.json` carries
 * `type: "mcp-server"` + the scoped `@scope/name` at the top level. The
 * server payload referenced by `server.entry_point` is left untouched by
 * the parser, so an empty stub is sufficient to exercise the import path.
 */
function buildMcpServerAfps(id: string): Uint8Array {
  const manifest = mcpServerManifest({
    name: id,
    version: "1.0.0",
    entryPoint: "main.js",
  });
  const entries: Record<string, Uint8Array> = {
    "manifest.json": enc(JSON.stringify(manifest, null, 2)),
    "main.js": enc("// mcp server entry stub\n"),
  };
  return zipSync(entries as unknown as Parameters<typeof zipSync>[0]);
}

describe("mcp-server package routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pkgorg" });
  });

  describe("POST /api/packages/import — mcp-server", () => {
    it("imports an mcp-server .afps: creates the package row (type mcp-server) + a version", async () => {
      const afps = buildMcpServerAfps(SERVER_ID);
      const form = new FormData();
      form.append("file", new Blob([afps]), "server.afps");

      const res = await app.request("/api/packages/import", {
        method: "POST",
        body: form,
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { packageId: string; type: string; version: string };
      expect(body.packageId).toBe(SERVER_ID);
      expect(body.type).toBe("mcp-server");
      expect(body.version).toBe("1.0.0");

      // Package row exists with the mcp-server type.
      const [pkg] = await db
        .select({ id: packages.id, type: packages.type, orgId: packages.orgId })
        .from(packages)
        .where(eq(packages.id, SERVER_ID))
        .limit(1);
      expect(pkg).toBeDefined();
      expect(pkg!.type).toBe("mcp-server");
      expect(pkg!.orgId).toBe(ctx.orgId);

      // A version row was created by post-install.
      const [ver] = await db
        .select({ version: packageVersions.version })
        .from(packageVersions)
        .where(eq(packageVersions.packageId, SERVER_ID))
        .limit(1);
      expect(ver).toBeDefined();
      expect(ver!.version).toBe("1.0.0");
    });

    it("rejects re-import as a different type (type_mismatch)", async () => {
      // First import as mcp-server.
      {
        const form = new FormData();
        form.append("file", new Blob([buildMcpServerAfps(SERVER_ID)]), "server.afps");
        const res = await app.request("/api/packages/import", {
          method: "POST",
          body: form,
          headers: authHeaders(ctx),
        });
        expect(res.status).toBe(201);
      }
      // Attempt to overwrite the same id with an agent .afps.
      const agentManifest = {
        name: SERVER_ID,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Impostor",
        author: "tester",
      };
      const agentAfps = zipSync({
        "manifest.json": enc(JSON.stringify(agentManifest)),
        "prompt.md": enc("Do the thing."),
      } as unknown as Parameters<typeof zipSync>[0]);
      const form = new FormData();
      form.append("file", new Blob([agentAfps]), "agent.afps");
      const res = await app.request("/api/packages/import", {
        method: "POST",
        body: form,
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("type_mismatch");
    });
  });

  describe("GET /api/packages/mcp-servers", () => {
    it("returns an empty list when no mcp-servers exist", async () => {
      const res = await app.request("/api/packages/mcp-servers", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { object: string; data: unknown[] };
      expect(body.object).toBe("list");
      expect(body.data).toBeArray();
    });

    it("lists an installed mcp-server", async () => {
      await seedPackage({
        id: SERVER_ID,
        orgId: ctx.orgId,
        type: "mcp-server",
        createdBy: ctx.user.id,
        draftManifest: mcpServerManifest({ name: SERVER_ID, version: "1.0.0" }),
        draftContent: JSON.stringify(mcpServerManifest({ name: SERVER_ID, version: "1.0.0" })),
      });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, SERVER_ID);

      const res = await app.request("/api/packages/mcp-servers", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      const found = body.data.find((p) => p.id === SERVER_ID);
      expect(found).toBeDefined();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/packages/mcp-servers");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/packages/mcp-servers/:scope/:name", () => {
    it("returns the mcp-server detail", async () => {
      await seedPackage({
        id: SERVER_ID,
        orgId: ctx.orgId,
        type: "mcp-server",
        createdBy: ctx.user.id,
        draftManifest: mcpServerManifest({ name: SERVER_ID, version: "1.0.0" }),
        draftContent: JSON.stringify(mcpServerManifest({ name: SERVER_ID, version: "1.0.0" })),
      });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, SERVER_ID);

      const res = await app.request(`/api/packages/mcp-servers/${SERVER_ID}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe(SERVER_ID);
    });

    it("returns 404 for a non-existent mcp-server", async () => {
      const res = await app.request("/api/packages/mcp-servers/@pkgorg/nope", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for an mcp-server owned by another org", async () => {
      const other = await createTestContext({ orgSlug: "alienmcp" });
      await seedPackage({
        id: "@alienmcp/private-server",
        orgId: other.orgId,
        type: "mcp-server",
        createdBy: other.user.id,
        draftManifest: mcpServerManifest({ name: "@alienmcp/private-server", version: "1.0.0" }),
      });

      const res = await app.request("/api/packages/mcp-servers/@alienmcp/private-server", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request(`/api/packages/mcp-servers/${SERVER_ID}`);
      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════
  // Issue #987 — `POST /api/packages/mcp-servers` is the ONLY create route
  // reaching `parsePackageUpload` (`jsonBodyCreate: false`). Three doors used
  // to put a manifest no AFPS schema accepts into the IMMUTABLE
  // `package_versions.manifest` row:
  //   - a ZIP with no `manifest.json`      → parsed as `undefined`
  //   - a ZIP with malformed `manifest.json` → parsed as `undefined`
  //   - a JSON body with no `manifest`     → optional in the Zod schema
  // …after which `validateManifest` was skipped (`if (parsed.manifest)`) and
  // `createOrgItem` synthesized a `{version, name, $schema, type}` stub. A
  // fourth door needed no absence at all: a VALID manifest of another type
  // validated against its own schema, then had `type` rewritten to the route's.
  //
  // The assertion that matters is therefore never the status code alone: on
  // every accepted write the stored manifest must PASS `validateManifest`, and
  // on every rejected one NOTHING may be persisted.
  // ═══════════════════════════════════════════════

  describe("POST /api/packages/mcp-servers — manifest gate (#987)", () => {
    const CREATE_PATH = "/api/packages/mcp-servers";
    /** Multipart derives the package id from the file name; JSON body sends it. */
    const SLUG = "gate-server";
    const GATE_ID = `@pkgorg/${SLUG}`;

    function zipOf(entries: Record<string, string>): Uint8Array {
      const out: Record<string, Uint8Array> = {};
      for (const [path, text] of Object.entries(entries)) out[path] = enc(text);
      return zipSync(out as unknown as Parameters<typeof zipSync>[0]);
    }

    async function postZip(entries: Record<string, string>): Promise<Response> {
      const form = new FormData();
      form.append("file", new Blob([zipOf(entries)]), `${SLUG}.afps`);
      return await app.request(CREATE_PATH, {
        method: "POST",
        body: form,
        headers: authHeaders(ctx),
      });
    }

    async function postJson(body: Record<string, unknown>): Promise<Response> {
      return await app.request(CREATE_PATH, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
    }

    /** A valid mcp-server manifest for the id this describe block creates. */
    function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return { ...mcpServerManifest({ name: GATE_ID, version: "1.0.0" }), ...overrides };
    }

    /**
     * A VALID manifest of a different package type. `validateManifest`
     * dispatches on the manifest's own root `type`, so this passes
     * `skillManifestSchema` — the route's own type is the only thing that can
     * reject it.
     */
    function validSkillManifest(): Record<string, unknown> {
      return {
        name: GATE_ID,
        version: "1.0.0",
        type: "skill",
        schema_version: "0.1",
        display_name: "Impostor Skill",
        description: "Valid as a skill, invalid as an mcp-server",
      };
    }

    /**
     * A rejected create must leave NO trace: not the `packages` draft row, and
     * above all not the immutable `package_versions` row the bug published.
     * `truncateAll()` runs in `beforeEach` and this block seeds nothing, so
     * "nothing persisted" is exactly "both tables empty".
     */
    async function expectNothingPersisted(): Promise<void> {
      expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
      expect(await db.select({ id: packageVersions.id }).from(packageVersions)).toEqual([]);
    }

    /**
     * The invariant of #987: the manifest that reached the immutable version
     * row (and the draft it was snapshotted from) is one an AFPS schema
     * accepts. `errors` is asserted first so a failure names the offending
     * field instead of printing `false !== true`.
     */
    async function expectStoredManifestsAreSchemaValid(packageId: string): Promise<void> {
      const [pkg] = await db
        .select({ type: packages.type, draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, packageId))
        .limit(1);
      expect(pkg).toBeDefined();
      expect(pkg!.type).toBe("mcp-server");

      const [ver] = await db
        .select({ version: packageVersions.version, manifest: packageVersions.manifest })
        .from(packageVersions)
        .where(eq(packageVersions.packageId, packageId))
        .limit(1);
      expect(ver).toBeDefined();

      const published = validateManifest(ver!.manifest);
      expect(published.errors ?? []).toEqual([]);
      expect(published.valid).toBe(true);
      expect((ver!.manifest as Record<string, unknown>).type).toBe("mcp-server");

      // The draft is what a later `POST …/versions` freezes into the NEXT
      // immutable row, so it carries the same invariant.
      const draft = validateManifest(pkg!.draftManifest);
      expect(draft.errors ?? []).toEqual([]);
      expect(draft.valid).toBe(true);
    }

    // ── multipart ZIP ──────────────────────────────

    it("rejects a ZIP with no manifest.json", async () => {
      const res = await postZip({ "main.js": "// entry stub\n" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; detail: string; param?: string };
      expect(body.code).toBe("invalid_request");
      expect(body.param).toBe("file");
      expect(body.detail).toContain("manifest.json");
      await expectNothingPersisted();
    });

    it("rejects a ZIP whose manifest.json is malformed JSON", async () => {
      const res = await postZip({
        "manifest.json": '{ "name": "@pkgorg/gate-server", ',
        "main.js": "// entry stub\n",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; param?: string };
      expect(body.code).toBe("invalid_request");
      expect(body.param).toBe("file");
      await expectNothingPersisted();
    });

    it("rejects a ZIP whose manifest parses but fails the mcp-server schema", async () => {
      // NOTE: this door was already closed — a manifest that PARSES took the
      // `if (parsed.manifest)` true branch and got validated. Kept as the
      // boundary between the two cases above (absent/malformed → `undefined` →
      // no validation at all) and a real schema rejection.
      const { server: _dropped, ...noServer } = validManifest();
      const res = await postZip({
        "manifest.json": JSON.stringify(noServer),
        "main.js": "// entry stub\n",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        code: string;
        errors?: { field: string; message: string }[];
      };
      expect(body.code).toBe("validation_failed");
      expect(body.errors?.map((e) => e.field)).toContain("manifest.server");
      await expectNothingPersisted();
    });

    it("rejects a ZIP carrying a VALID manifest of another type, naming manifest.type", async () => {
      const res = await postZip({
        "manifest.json": JSON.stringify(validSkillManifest()),
        "main.js": "// entry stub\n",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        code: string;
        detail: string;
        errors?: { field: string; message: string }[];
      };
      expect(body.code).toBe("validation_failed");
      const typeError = body.errors?.find((e) => e.field === "manifest.type");
      expect(typeError).toBeDefined();
      expect(typeError!.message).toContain("mcp-server");
      expect(typeError!.message).toContain("skill");
      await expectNothingPersisted();
    });

    it("accepts a valid ZIP and stores a schema-valid manifest in the version row", async () => {
      const res = await postZip({
        "manifest.json": JSON.stringify(validManifest(), null, 2),
        "main.js": "// entry stub\n",
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe(GATE_ID);
      await expectStoredManifestsAreSchemaValid(GATE_ID);
    });

    // ── JSON body ──────────────────────────────────

    it("rejects a JSON body with no manifest", async () => {
      const res = await postJson({ id: SLUG, content: "{}" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        code: string;
        errors?: { field: string }[];
      };
      expect(body.code).toBe("validation_failed");
      expect(body.errors?.map((e) => e.field)).toContain("manifest");
      await expectNothingPersisted();
    });

    it("rejects a JSON body carrying a VALID manifest of another type", async () => {
      const manifest = validSkillManifest();
      const res = await postJson({ id: SLUG, content: JSON.stringify(manifest), manifest });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; errors?: { field: string }[] };
      expect(body.code).toBe("validation_failed");
      expect(body.errors?.map((e) => e.field)).toContain("manifest.type");
      await expectNothingPersisted();
    });

    it("accepts a valid JSON body and stores a schema-valid manifest in the version row", async () => {
      const manifest = validManifest();
      const res = await postJson({
        id: SLUG,
        content: JSON.stringify(manifest, null, 2),
        manifest,
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe(GATE_ID);
      await expectStoredManifestsAreSchemaValid(GATE_ID);
    });
  });

  // ═══════════════════════════════════════════════
  // Issue #987 — the same gate on `PUT`, which is directional per request:
  // a body SUPPLYING `manifest` is author input ("author" — type gated), a
  // content-only body carries the ALREADY-STORED draft forward ("stored" — not
  // gated, because #983 settled that persisted artifacts are tolerated on read
  // and a gate here would make a legacy drifted draft permanently un-editable
  // and un-publishable).
  // ═══════════════════════════════════════════════

  describe("PUT /api/packages/mcp-servers/:scope/:name — author vs stored direction", () => {
    const PUT_ID = "@pkgorg/put-server";

    async function currentLockVersion(packageId: string): Promise<number> {
      const [row] = await db
        .select({ lockVersion: packages.lockVersion })
        .from(packages)
        .where(eq(packages.id, packageId))
        .limit(1);
      return row!.lockVersion;
    }

    async function storedDraftManifest(packageId: string): Promise<Record<string, unknown>> {
      const [row] = await db
        .select({ draftManifest: packages.draftManifest })
        .from(packages)
        .where(eq(packages.id, packageId))
        .limit(1);
      return row!.draftManifest as Record<string, unknown>;
    }

    async function put(packageId: string, body: Record<string, unknown>): Promise<Response> {
      return await app.request(`/api/packages/mcp-servers/${packageId}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
    }

    /** A valid manifest of ANOTHER type, keeping `name` so only `type` differs. */
    function skillManifestFor(packageId: string): Record<string, unknown> {
      return {
        name: packageId,
        version: "1.0.0",
        type: "skill",
        schema_version: "0.1",
        display_name: "Impostor Skill",
        description: "Valid as a skill, invalid as an mcp-server",
      };
    }

    it("rejects an AUTHORED manifest of the wrong type and leaves the draft untouched", async () => {
      await seedPackage({
        id: PUT_ID,
        orgId: ctx.orgId,
        type: "mcp-server",
        createdBy: ctx.user.id,
        draftManifest: mcpServerManifest({ name: PUT_ID, version: "1.0.0" }),
        draftContent: "{}",
      });
      const before = await storedDraftManifest(PUT_ID);

      const res = await put(PUT_ID, {
        manifest: skillManifestFor(PUT_ID),
        lock_version: await currentLockVersion(PUT_ID),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; errors?: { field: string }[] };
      expect(body.code).toBe("validation_failed");
      expect(body.errors?.map((e) => e.field)).toContain("manifest.type");
      // The draft a later publish would freeze is unchanged.
      expect(await storedDraftManifest(PUT_ID)).toEqual(before);
    });

    it("accepts a content-only save (no manifest in the body)", async () => {
      await seedPackage({
        id: PUT_ID,
        orgId: ctx.orgId,
        type: "mcp-server",
        createdBy: ctx.user.id,
        draftManifest: mcpServerManifest({ name: PUT_ID, version: "1.0.0" }),
        draftContent: "{}",
      });

      const res = await put(PUT_ID, {
        content: '{"edited":true}',
        lock_version: await currentLockVersion(PUT_ID),
      });

      expect(res.status).toBe(200);
      const stored = validateManifest(await storedDraftManifest(PUT_ID));
      expect(stored.errors ?? []).toEqual([]);
      expect(stored.valid).toBe(true);
    });

    it("still accepts a content-only save on a package whose STORED manifest type drifted", async () => {
      // The legacy state the "stored" direction exists for: a row typed
      // `mcp-server` whose persisted draft manifest says `skill` (the shape the
      // #481 migration and the pre-fix create path both left behind). The
      // content-only save must go through — otherwise the drifted draft is
      // permanently un-editable — while the authored save on the SAME row is
      // rejected. That contrast is the whole author/stored split.
      await seedPackage({
        id: PUT_ID,
        orgId: ctx.orgId,
        type: "mcp-server",
        createdBy: ctx.user.id,
        draftManifest: skillManifestFor(PUT_ID),
        draftContent: "{}",
      });

      const contentOnly = await put(PUT_ID, {
        content: '{"edited":true}',
        lock_version: await currentLockVersion(PUT_ID),
      });
      expect(contentOnly.status).toBe(200);

      const authored = await put(PUT_ID, {
        manifest: skillManifestFor(PUT_ID),
        lock_version: await currentLockVersion(PUT_ID),
      });
      expect(authored.status).toBe(400);
      const body = (await authored.json()) as { errors?: { field: string }[] };
      expect(body.errors?.map((e) => e.field)).toContain("manifest.type");
    });

    it("still publishes a drifted STORED draft (no type gate on the publish path)", async () => {
      // FORWARD guard, not a regression: publishing was ungated before the fix
      // too. It pins the deliberate asymmetry — closing the author door must
      // never close this one, or a legacy drifted draft becomes permanently
      // un-publishable (#983).
      const drifted = skillManifestFor(PUT_ID);
      await seedPackage({
        id: PUT_ID,
        orgId: ctx.orgId,
        type: "mcp-server",
        createdBy: ctx.user.id,
        draftManifest: drifted,
        draftContent: "{}",
      });
      // An mcp-server publish zips its STORED draft files, so they must exist.
      await uploadPackageFiles("mcp-servers", ctx.orgId, PUT_ID, {
        "manifest.json": enc(JSON.stringify(drifted, null, 2)),
      });

      const res = await app.request(`/api/packages/mcp-servers/${PUT_ID}/versions`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
    });
  });
});
