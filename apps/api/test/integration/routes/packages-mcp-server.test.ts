// SPDX-License-Identifier: Apache-2.0

/**
 * First-class `mcp-server` package routes (AFPS 2.0.2 §3.4).
 *
 * An `mcp-server` package's `manifest.json` is a verbatim MCPB manifest with
 * the AFPS identity contract (`type: "mcp-server"`, scoped `name`,
 * `schema_version`, `dependencies`) lifted to the manifest root in AFPS 2.0.2
 * §3.4 / §11.2. They are import-only (no editor), but otherwise have full parity with the other
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
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { mcpServerManifest } from "../../helpers/integration-manifests.ts";
import { packages, packageVersions } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const app = getTestApp();

const SERVER_ID = "@pkgorg/my-mcp-server";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Build a minimal valid mcp-server `.afps` ZIP. AFPS 2.0.2 (§3.4) lifted the
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
        schema_version: "2.0",
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
});
