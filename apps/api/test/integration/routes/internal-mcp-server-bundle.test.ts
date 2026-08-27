// SPDX-License-Identifier: Apache-2.0

/**
 * GET /internal/mcp-server-bundle/:scope/:name — fail-closed authorization.
 *
 * In AFPS a `source.kind: "local"` integration references a SEPARATE
 * mcp-server package via `source.server.name`. The sidecar fetches that
 * package's `.afps` bundle bytes here before spawning a runner. The endpoint
 * is authorised by the per-run Bearer token AND `assertAgentReferencesMcpServer`,
 * which verifies the running agent declares an INSTALLED integration that
 * references this mcp-server. A leaked run token must not be able to enumerate
 * arbitrary mcp-server source across the org.
 *
 * Covers:
 *   (a) ALLOW — installed agent → installed integration (local source) →
 *       references mcp-server X → requesting X's bundle returns the bytes.
 *   (b) DENY — requesting an mcp-server NOT referenced by any installed
 *       integration → 404 (fail-closed).
 *   Plus the surrounding auth boundary (no token, integration not installed).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { eq } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import {
  localIntegrationManifest,
  mcpServerManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { installPackage } from "../../../src/services/space-packages.ts";
import { _setSystemPackagesForTesting } from "../../../src/services/system-packages.ts";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";

const BUCKET = "agent-packages";
const app = getTestApp();

const AGENT = "@mcporg/test-agent";
const INTEGRATION = "@mcporg/local-integ";
const MCP_SERVER = "@mcporg/local-server";
const ORPHAN_SERVER = "@mcporg/unreferenced-server";
const SYSTEM_SERVER = "@appstrate/mcp-server-system-fixture";

const SERVER_VERSION = "1.0.0";
// Distinctive payload so the ALLOW case can assert the exact bytes are returned.
const SERVER_BUNDLE_BYTES = new TextEncoder().encode("PK-mcp-server-bundle-bytes-marker");
const SYSTEM_BUNDLE_BYTES = new TextEncoder().encode("PK-system-boot-registry-bytes-marker");

/** Minimal boot-registry entry — the byte route reads `zipBuffer` and nothing else. */
function systemEntry(id: string, bytes: Uint8Array): SystemPackageEntry {
  const slash = id.indexOf("/");
  return {
    packageId: id,
    scope: id.slice(0, slash),
    name: id.slice(slash + 1),
    type: "mcp-server",
    version: SERVER_VERSION,
    manifest: mcpServerManifest({ name: id, version: SERVER_VERSION }),
    zipBuffer: Buffer.from(bytes),
    content: "",
    files: {},
  };
}

describe("GET /internal/mcp-server-bundle/:scope/:name", () => {
  let ctx: TestContext;
  let runId: string;
  let token: string;

  /** Seed the integration package + manifest referencing an mcp-server via local source. */
  async function seedLocalIntegration(installed: boolean, serverName = MCP_SERVER) {
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEGRATION,
        serverName,
        version: "1.0.0",
        auths: {
          primary: {
            type: "api_key",
            authorizedUris: ["https://api.example.com/**"],
            credentialFields: ["api_key"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
        tools_policy: { search: {} },
      }),
    });
    if (installed) {
      await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);
    }
  }

  /** Seed an mcp-server package + a published, downloadable version. */
  async function seedMcpServerWithBundle(id: string, bytes: Uint8Array) {
    const manifest = mcpServerManifest({ name: id, version: SERVER_VERSION });
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: manifest,
    });
    const integrity = computeIntegrity(bytes);
    await storage.uploadFile(BUCKET, `${id}/${SERVER_VERSION}.afps`, Buffer.from(bytes));
    await seedPackageVersion({
      packageId: id,
      version: SERVER_VERSION,
      integrity,
      artifactSize: bytes.length,
      manifest,
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mcporg" });

    // The running agent declares the integration as a dependency. The route
    // reads `manifest.dependencies.integrations` keys to find references.
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: "Test Agent",
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
      },
    });
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);

    const run = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
    });
    runId = run.id;
    token = signRunToken(runId);
  });

  it("returns 401 without a run token", async () => {
    const res = await app.request(`/internal/mcp-server-bundle/${MCP_SERVER}`);
    expect(res.status).toBe(401);
  });

  it("ALLOW: returns the bundle bytes for an mcp-server referenced by an installed integration", async () => {
    await seedLocalIntegration(true);
    await seedMcpServerWithBundle(MCP_SERVER, SERVER_BUNDLE_BYTES);

    const res = await app.request(
      `/internal/mcp-server-bundle/${MCP_SERVER}?version=${SERVER_VERSION}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(SERVER_BUNDLE_BYTES));
  });

  it("DENY: returns 404 for an mcp-server not referenced by any installed integration", async () => {
    // The referenced integration + its server are seeded so the catalog is
    // non-trivial, but ORPHAN_SERVER is referenced by NOTHING the agent declares.
    await seedLocalIntegration(true);
    await seedMcpServerWithBundle(MCP_SERVER, SERVER_BUNDLE_BYTES);
    await seedMcpServerWithBundle(ORPHAN_SERVER, SERVER_BUNDLE_BYTES);

    const res = await app.request(`/internal/mcp-server-bundle/${ORPHAN_SERVER}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Fail-closed: the agent declares no integration referencing ORPHAN_SERVER.
    expect(res.status).toBe(404);
  });

  it("serves the EXACT version requested via ?version=, and refuses to guess when absent", async () => {
    // #588 — the spawn resolver pins a concrete version and the sidecar
    // forwards it as ?version=. The route must serve THAT version's bytes even
    // when a newer version exists, so manifest and bytes never skew.
    await seedLocalIntegration(true);
    const v100 = new TextEncoder().encode("bytes-of-1.0.0");
    const v101 = new TextEncoder().encode("bytes-of-1.0.1-LATEST");
    const manifest = mcpServerManifest({ name: MCP_SERVER, version: "1.0.0" });
    await seedPackage({
      id: MCP_SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: manifest,
    });
    // Two published versions; 1.0.1 is the newest (latest by createdAt).
    await storage.uploadFile(BUCKET, `${MCP_SERVER}/1.0.0.afps`, Buffer.from(v100));
    await seedPackageVersion({
      packageId: MCP_SERVER,
      version: "1.0.0",
      integrity: computeIntegrity(v100),
      artifactSize: v100.length,
      manifest,
    });
    await storage.uploadFile(BUCKET, `${MCP_SERVER}/1.0.1.afps`, Buffer.from(v101));
    await seedPackageVersion({
      packageId: MCP_SERVER,
      version: "1.0.1",
      integrity: computeIntegrity(v101),
      artifactSize: v101.length,
      manifest: mcpServerManifest({ name: MCP_SERVER, version: "1.0.1" }),
    });

    // Explicit pin → 1.0.0 bytes, even though 1.0.1 is newer.
    const pinned = await app.request(`/internal/mcp-server-bundle/${MCP_SERVER}?version=1.0.0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pinned.status).toBe(200);
    expect(Array.from(new Uint8Array(await pinned.arrayBuffer()))).toEqual(Array.from(v100));

    // No pin → 400. This assertion is the INVERSE of the one it replaces: the
    // route used to serve the newest published version (1.0.1) when `?version=`
    // was absent, which is the manifest/bytes skew #588 closed reopening
    // through the byte route. There is no "latest" fallback any more.
    const unpinned = await app.request(`/internal/mcp-server-bundle/${MCP_SERVER}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unpinned.status).toBe(400);
    const problem = (await unpinned.json()) as { code: string; param?: string; detail: string };
    expect(problem.code).toBe("invalid_request");
    expect(problem.param).toBe("version");
    expect(problem.detail).toContain("version");
  });

  it("serves a SYSTEM mcp-server from the boot registry without ?version=", async () => {
    // Positive control for the short-circuit that survives the rule above: the
    // boot registry holds one version per id, so the spawn resolver pins no
    // version for a system mcp-server and the sidecar legitimately omits
    // `?version=`. The route answers from that registry before it ever reads
    // the query. `getTestApp()` skips `boot()`, so the registry is empty
    // unless a test installs one.
    await seedLocalIntegration(true, SYSTEM_SERVER);
    const restore = _setSystemPackagesForTesting(
      new Map([[SYSTEM_SERVER, systemEntry(SYSTEM_SERVER, SYSTEM_BUNDLE_BYTES)]]),
    );
    try {
      const res = await app.request(`/internal/mcp-server-bundle/${SYSTEM_SERVER}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/zip");
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(
        Array.from(SYSTEM_BUNDLE_BYTES),
      );
    } finally {
      restore();
    }
  });

  it("returns 404 for a ?version= that does not exist", async () => {
    await seedLocalIntegration(true);
    await seedMcpServerWithBundle(MCP_SERVER, SERVER_BUNDLE_BYTES); // only 1.0.0

    const res = await app.request(`/internal/mcp-server-bundle/${MCP_SERVER}?version=9.9.9`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("DENY: returns 404 when the referencing integration is declared but NOT installed in the space", async () => {
    // The integration that references MCP_SERVER exists and is declared by the
    // agent, but is not in `space_packages` — the guard requires an
    // installed integration, so the reference does not count.
    await seedLocalIntegration(false);
    await seedMcpServerWithBundle(MCP_SERVER, SERVER_BUNDLE_BYTES);

    const res = await app.request(`/internal/mcp-server-bundle/${MCP_SERVER}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
  });

  it("ALLOW: a version-pinned run keeps bundle access when the draft dropped the integration dep", async () => {
    // Regression (@tractr/fathom-glenn class): the guard must enumerate the
    // deps of the manifest the run EXECUTES. Published agent 2.0.0 declares
    // the integration referencing MCP_SERVER; the draft no longer does. A run
    // pinned to 2.0.0 must still fetch the server bundle at boot.
    await seedLocalIntegration(true);
    await seedMcpServerWithBundle(MCP_SERVER, SERVER_BUNDLE_BYTES);

    const pinnedManifest = {
      name: AGENT,
      version: "2.0.0",
      type: "agent",
      schema_version: "0.2",
      display_name: "Test Agent",
      dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
      integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
    };
    await seedPackageVersion({ packageId: AGENT, version: "2.0.0", manifest: pinnedManifest });
    await db
      .update(packages)
      .set({
        draftManifest: {
          name: AGENT,
          version: "2.0.1",
          type: "agent",
          schema_version: "0.2",
          display_name: "Test Agent",
          dependencies: { integrations: {} },
          integrations_configuration: {},
        },
      })
      .where(eq(packages.id, AGENT));

    const pinnedRun = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
      versionRef: "2.0.0",
    });
    const pinnedToken = signRunToken(pinnedRun.id);

    // The pinned run reads the 2.0.0 dep set → ALLOW.
    const res = await app.request(
      `/internal/mcp-server-bundle/${MCP_SERVER}?version=${SERVER_VERSION}`,
      { headers: { Authorization: `Bearer ${pinnedToken}` } },
    );
    expect(res.status).toBe(200);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(
      Array.from(SERVER_BUNDLE_BYTES),
    );

    // The original draft-ref run (beforeEach) now sees an empty draft dep set → DENY.
    const draftRes = await app.request(
      `/internal/mcp-server-bundle/${MCP_SERVER}?version=${SERVER_VERSION}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(draftRes.status).toBe(404);
  });
});
