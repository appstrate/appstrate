// SPDX-License-Identifier: Apache-2.0

/**
 * GET /internal/integration-bundle/:scope/:name — fail-closed authorization.
 *
 * A `source.kind: "local"` integration declares its MCP server inline and ships the payload in its
 * OWN archive. The sidecar fetches that archive here before spawning a runner. The endpoint is
 * authorised by the per-run Bearer token AND `assertAgentDeclaresLocalIntegration`: the running
 * agent must declare an ACTIVE integration, and it must be a local one. A leaked run token must
 * not enumerate arbitrary integration source across the org.
 *
 * Which bytes follow the run's frozen version (`runs.resolved_integration_versions`): the exact
 * published version, the boot registry for a system integration, the draft files for a draft run.
 *
 * Covers:
 *   (a) ALLOW — declared + active local integration → its archive.
 *   (b) DENY — an integration the agent does not declare, a non-local one, an inactive one.
 *   (c) version rules — exact published version only; a system / draft run refuses `?version=`.
 *   (d) system integration from the boot registry; draft run from the draft files.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { eq } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { unzipArtifact } from "@appstrate/core/zip";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import {
  localIntegrationManifest,
  remoteIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { _setSystemPackagesForTesting } from "../../../src/services/system-packages.ts";
import type { SystemPackageEntry } from "@appstrate/core/system-packages";

const BUCKET = "agent-packages";
const app = getTestApp();

const AGENT = "@bundleorg/test-agent";
const INTEGRATION = "@bundleorg/local-integ";
const OTHER_INTEGRATION = "@bundleorg/undeclared-integ";
const REMOTE_INTEGRATION = "@bundleorg/remote-integ";
const SYSTEM_INTEGRATION = "@appstrate/integration-system-fixture";

const VERSION = "1.0.0";
// Distinctive payloads so each case can assert the exact bytes returned.
const ARCHIVE_BYTES = new TextEncoder().encode("PK-integration-archive-bytes-marker");
const SYSTEM_BYTES = new TextEncoder().encode("PK-system-boot-registry-bytes-marker");

const AUTH = {
  primary: {
    type: "api_key" as const,
    authorizedUris: ["https://api.example.com/**"],
    credentialFields: ["api_key"],
    delivery: httpHeaderDelivery({ name: "Authorization", prefix: "Bearer ", field: "api_key" }),
  },
};

function localManifest(name: string, version = VERSION) {
  return localIntegrationManifest({ name, version, auths: AUTH, tools_policy: { search: {} } });
}

/** Minimal boot-registry entry — the byte route reads `zipBuffer` and nothing else. */
function systemEntry(id: string, bytes: Uint8Array): SystemPackageEntry {
  const slash = id.indexOf("/");
  return {
    packageId: id,
    scope: id.slice(0, slash),
    name: id.slice(slash + 1),
    type: "integration",
    version: VERSION,
    manifest: localManifest(id) as unknown as Record<string, unknown>,
    zipBuffer: Buffer.from(bytes),
    content: "",
    files: {},
  };
}

describe("GET /internal/integration-bundle/:scope/:name", () => {
  let ctx: TestContext;
  let token: string;

  function url(id: string, version?: string) {
    return `/internal/integration-bundle/${id}${version ? `?version=${version}` : ""}`;
  }
  const bearer = () => ({ headers: { Authorization: `Bearer ${token}` } });

  /** Seed a local integration package; `published` also uploads a downloadable version. */
  async function seedLocalIntegration(
    id: string,
    opts: { installed?: boolean; published?: boolean; bytes?: Uint8Array; version?: string } = {},
  ) {
    const version = opts.version ?? VERSION;
    const manifest = localManifest(id, version);
    await seedPackage({
      id,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    if (opts.installed ?? true) {
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id);
    }
    if (opts.published) {
      const bytes = opts.bytes ?? ARCHIVE_BYTES;
      await storage.uploadFile(BUCKET, `${id}/${version}.afps`, Buffer.from(bytes));
      await seedPackageVersion({
        packageId: id,
        version,
        integrity: computeIntegrity(bytes),
        artifactSize: bytes.length,
        manifest,
      });
    }
  }

  /** A run of the agent that froze `frozen` for the integration. */
  async function runFreezing(
    frozen?: { source: "version" | "draft" | "system"; version: string | null },
    integrationId = INTEGRATION,
  ) {
    const run = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
      ...(frozen ? { resolvedIntegrationVersions: { [integrationId]: frozen } } : {}),
    });
    token = signRunToken(run.id);
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bundleorg" });

    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
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
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    await runFreezing({ source: "version", version: VERSION });
  });

  it("returns 401 without a run token", async () => {
    const res = await app.request(url(INTEGRATION));
    expect(res.status).toBe(401);
  });

  it("ALLOW: returns the integration's archive for a declared, active local integration", async () => {
    await seedLocalIntegration(INTEGRATION, { published: true });

    const res = await app.request(url(INTEGRATION, VERSION), bearer());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(ARCHIVE_BYTES));
  });

  it("DENY: 404 for an integration the run's agent does not declare", async () => {
    await seedLocalIntegration(INTEGRATION, { published: true });
    await seedLocalIntegration(OTHER_INTEGRATION, { published: true });

    const res = await app.request(url(OTHER_INTEGRATION, VERSION), bearer());

    // Fail-closed: the agent's dependencies name only INTEGRATION.
    expect(res.status).toBe(404);
  });

  it("DENY: 404 when the declared integration is NOT active in the space", async () => {
    await seedLocalIntegration(INTEGRATION, { installed: false, published: true });

    const res = await app.request(url(INTEGRATION, VERSION), bearer());

    expect(res.status).toBe(404);
  });

  it("DENY: 404 for a declared integration that is not a local one (no archive to serve)", async () => {
    await db
      .update(packages)
      .set({
        draftManifest: {
          name: AGENT,
          version: "1.0.0",
          type: "agent",
          schema_version: "0.2",
          display_name: "Test Agent",
          dependencies: { integrations: { [REMOTE_INTEGRATION]: "^1.0.0" } },
          integrations_configuration: { [REMOTE_INTEGRATION]: { tools: ["search"] } },
        },
      })
      .where(eq(packages.id, AGENT));
    await seedPackage({
      id: REMOTE_INTEGRATION,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: remoteIntegrationManifest({
        name: REMOTE_INTEGRATION,
        version: VERSION,
        auths: AUTH,
        tools_policy: { search: {} },
      }),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, REMOTE_INTEGRATION);
    await runFreezing(undefined);

    const res = await app.request(url(REMOTE_INTEGRATION), bearer());

    expect(res.status).toBe(404);
  });

  it("serves the EXACT version the run froze, refusing any other and an absent one", async () => {
    // The spawn spec names the frozen version and the sidecar forwards it as ?version=. The route
    // serves THAT version's bytes even when a newer one exists, so manifest and bytes never skew.
    await seedLocalIntegration(INTEGRATION, { published: true });
    const v101 = new TextEncoder().encode("bytes-of-1.0.1-LATEST");
    await storage.uploadFile(BUCKET, `${INTEGRATION}/1.0.1.afps`, Buffer.from(v101));
    await seedPackageVersion({
      packageId: INTEGRATION,
      version: "1.0.1",
      integrity: computeIntegrity(v101),
      artifactSize: v101.length,
      manifest: localManifest(INTEGRATION, "1.0.1"),
    });

    const pinned = await app.request(url(INTEGRATION, VERSION), bearer());
    expect(pinned.status).toBe(200);
    expect(Array.from(new Uint8Array(await pinned.arrayBuffer()))).toEqual(
      Array.from(ARCHIVE_BYTES),
    );

    // A version other than the frozen one — even a real, newer one — is not this run's to read.
    expect((await app.request(url(INTEGRATION, "1.0.1"), bearer())).status).toBe(404);
    // No "latest" and no draft fallback for a run that froze a published version.
    expect((await app.request(url(INTEGRATION), bearer())).status).toBe(404);
  });

  it("serves a SYSTEM integration from the boot registry, refusing a ?version=", async () => {
    // `getTestApp()` skips `boot()`, so the registry is empty unless a test installs one.
    await seedLocalIntegration(SYSTEM_INTEGRATION, { published: false });
    await db
      .update(packages)
      .set({
        draftManifest: {
          name: AGENT,
          version: "1.0.0",
          type: "agent",
          schema_version: "0.2",
          display_name: "Test Agent",
          dependencies: { integrations: { [SYSTEM_INTEGRATION]: "^1.0.0" } },
          integrations_configuration: { [SYSTEM_INTEGRATION]: { tools: ["search"] } },
        },
      })
      .where(eq(packages.id, AGENT));
    await runFreezing({ source: "system", version: null }, SYSTEM_INTEGRATION);
    const restore = _setSystemPackagesForTesting(
      new Map([[SYSTEM_INTEGRATION, systemEntry(SYSTEM_INTEGRATION, SYSTEM_BYTES)]]),
    );
    try {
      const res = await app.request(url(SYSTEM_INTEGRATION), bearer());
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/zip");
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(SYSTEM_BYTES));
      expect((await app.request(url(SYSTEM_INTEGRATION, VERSION), bearer())).status).toBe(404);
    } finally {
      restore();
    }
  });

  it("serves the DRAFT files of an integration the run froze on its draft", async () => {
    await seedLocalIntegration(INTEGRATION, { published: true });
    await uploadPackageFiles("integrations", ctx.orgId, INTEGRATION, {
      "manifest.json": new TextEncoder().encode(JSON.stringify(localManifest(INTEGRATION))),
      "server/index.js": new TextEncoder().encode("// draft server payload"),
    });
    await runFreezing({ source: "draft", version: null });

    const res = await app.request(url(INTEGRATION), bearer());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const files = unzipArtifact(new Uint8Array(await res.arrayBuffer()));
    expect(new TextDecoder().decode(files["server/index.js"])).toBe("// draft server payload");
    // A draft run names no version, and naming one is refused.
    expect((await app.request(url(INTEGRATION, VERSION), bearer())).status).toBe(404);
  });

  it("ALLOW: a version-pinned run keeps bundle access when the draft dropped the integration dep", async () => {
    // Regression (@tractr/fathom-glenn class): the guard must enumerate the deps of the manifest
    // the run EXECUTES. Published agent 2.0.0 declares the integration; the draft no longer does.
    await seedLocalIntegration(INTEGRATION, { published: true });

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

    const draftToken = token;
    const pinnedRun = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
      versionRef: "2.0.0",
      resolvedIntegrationVersions: { [INTEGRATION]: { source: "version", version: VERSION } },
    });

    const res = await app.request(url(INTEGRATION, VERSION), {
      headers: { Authorization: `Bearer ${signRunToken(pinnedRun.id)}` },
    });
    expect(res.status).toBe(200);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(ARCHIVE_BYTES));

    // The draft-ref run now sees an empty draft dep set → DENY.
    const draftRes = await app.request(url(INTEGRATION, VERSION), {
      headers: { Authorization: `Bearer ${draftToken}` },
    });
    expect(draftRes.status).toBe(404);
  });
});
