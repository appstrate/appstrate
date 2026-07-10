// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — `source.server.version` pin resolution (issue #588).
 *
 * A local-source integration references a SEPARATE mcp-server package via
 * `source.server: { name, version }`. Historically the resolver read the
 * server's manifest from `packages.draft_manifest` (version-blind) while the
 * runnable bytes came from the latest published version — so manifest and bytes
 * could be DIFFERENT versions, and a `publish` was not reflected on the run
 * until the draft was overwritten ("publish ≠ deploy" footgun).
 *
 * The resolver now resolves the mcp-server to ONE concrete published version
 * (honoring the pin: exact → dist-tag → semver range), reads THAT version's
 * manifest, and stamps the resolved version onto
 * `spec.manifest.server.version` so the byte route serves the same
 * version. This suite locks that contract:
 *
 *   - pin honored: a `^1.0.0` pin resolves to the highest matching version and
 *     EXCLUDES a newer out-of-range version (2.0.0), even though it is latest.
 *   - manifest follows the resolved version, NOT the draft (distinct entry_point).
 *   - unsatisfiable pin → run fails loud (`DEPENDENCY_UNRESOLVED`), never a
 *     silent degrade (#686 tightened this from the old warn-and-skip).
 *   - no published version → same loud failure (unrunnable byte route would
 *     otherwise 404 mid-run).
 *   - incident regression: publishing a new in-range version makes the run pick
 *     it up WITHOUT overwriting the draft.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";

import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  mcpServerManifest,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@pinorg/integ";
const SERVER = "@pinorg/server";

/** Local integration pinning the server at `^<integVersion>` (helper sets `^`). */
function integrationManifest(integVersion: string) {
  return localIntegrationManifest({
    name: INTEG,
    version: integVersion,
    serverName: SERVER,
    auths: {
      oauth: {
        type: "api_key",
        authorizedUris: ["https://api.example.com/**"],
        credentialFields: ["api_key"],
        delivery: { env: { API_KEY: { value: "{$credential.api_key}", sensitive: true } } },
      },
    },
    tools_policy: { search: {} },
  });
}

function agentManifest(): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: "@pinorg/agent",
    version: "1.0.0",
    display_name: "Agent",
    dependencies: { integrations: { [INTEG]: "^1.0.0" } },
    integrations_configuration: { [INTEG]: { tools: ["search"] } },
  };
}

async function seedConnection(ctx: TestContext) {
  await db.insert(integrationConnections).values({
    integrationId: INTEG,
    authKey: "oauth",
    accountId: "default",
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    endUserId: null,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
    identityClaims: {},
    scopesGranted: [],
    needsReconnection: false,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Seed a published mcp-server version with a per-version entry_point so a test
 *  can prove the manifest came from the resolved version (not the draft). */
async function seedServerVersion(version: string, entryPoint: string) {
  await seedPackageVersion({
    packageId: SERVER,
    version,
    manifest: mcpServerManifest({
      name: SERVER,
      version,
      serverType: "node",
      entryPoint,
    }),
  });
}

async function resolve(ctx: TestContext) {
  return resolveIntegrationSpawns({
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    actor: { type: "user", id: ctx.user.id },
    agentManifest: agentManifest(),
  });
}

describe("resolveIntegrationSpawns — source.server.version pin (#588)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pinorg" });
  });

  it("resolves the pin to the highest in-range version and EXCLUDES a newer out-of-range one", async () => {
    // Integration pins `^1.0.0`. Draft says 1.0.0 with a STALE entry_point; the
    // published versions are 1.0.0, 1.5.0 (newest in-range) and 2.0.0 (latest
    // overall, but excluded by `^1.0.0`).
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest("1.0.0"),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedPackage({
      id: SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: mcpServerManifest({
        name: SERVER,
        version: "1.0.0",
        serverType: "node",
        entryPoint: "./STALE-draft.js",
      }),
    });
    await seedServerVersion("1.0.0", "./v1.js");
    await seedServerVersion("1.5.0", "./v1_5.js");
    await seedServerVersion("2.0.0", "./v2.js");
    await seedConnection(ctx);

    const specs = await resolve(ctx);
    expect(specs.length).toBe(1);
    const server = specs[0]!.manifest.server!;
    // Highest version satisfying `^1.0.0` is 1.5.0 — NOT 2.0.0 (latest) and NOT
    // the stale draft.
    expect(server.version).toBe("1.5.0");
    expect(server.packageId).toBe(SERVER);
    // Manifest fields come from the RESOLVED version, never the draft.
    expect(server.entry_point).toBe("./v1_5.js");
  });

  it("fails loud when the server pin cannot be satisfied (no silent degrade, #686)", async () => {
    // Integration pins `^3.0.0`; only 1.0.0 is published → unsatisfiable. The
    // run must abort with DEPENDENCY_UNRESOLVED, never spawn without the
    // integration's tools.
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest("3.0.0"),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedPackage({
      id: SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: mcpServerManifest({ name: SERVER, version: "1.0.0", serverType: "node" }),
    });
    await seedServerVersion("1.0.0", "./v1.js");
    await seedConnection(ctx);

    expect(resolve(ctx)).rejects.toMatchObject({ code: "DEPENDENCY_UNRESOLVED" });
  });

  it("fails loud when the mcp-server has no published version (#686)", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest("1.0.0"),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedPackage({
      id: SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: mcpServerManifest({ name: SERVER, version: "1.0.0", serverType: "node" }),
    });
    // No seedPackageVersion → draft-only, unrunnable.
    await seedConnection(ctx);

    expect(resolve(ctx)).rejects.toMatchObject({ code: "DEPENDENCY_UNRESOLVED" });
  });

  it("regression: publishing a new in-range version is picked up WITHOUT overwriting the draft", async () => {
    // The incident: draft stays at 1.0.2 while 1.0.3 is published. The run must
    // resolve to 1.0.3 (manifest + bytes) on the pin `^1.0.0` — no draft
    // overwrite required.
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest("1.0.0"),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedPackage({
      id: SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      // Draft frozen at 1.0.2 with the OLD entry_point — never overwritten.
      draftManifest: mcpServerManifest({
        name: SERVER,
        version: "1.0.2",
        serverType: "node",
        entryPoint: "./v1_0_2-draft.js",
      }),
    });
    await seedServerVersion("1.0.2", "./v1_0_2.js");
    await seedServerVersion("1.0.3", "./v1_0_3.js");
    await seedConnection(ctx);

    const specs = await resolve(ctx);
    expect(specs.length).toBe(1);
    const server = specs[0]!.manifest.server!;
    expect(server.version).toBe("1.0.3");
    expect(server.entry_point).toBe("./v1_0_3.js");
  });
});
