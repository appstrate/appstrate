// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/*` authorization for an ephemeral CONNECT RUN.
 *
 * A connect run (`runAt: "link"` orchestrated `connect.tool` login) launches a
 * sidecar with a signed token whose id is `connect_<hex>`. That id has NO
 * `runs` row and the run has NO agent, so neither half of the run-token
 * pipeline can authorise it: `verifyRunToken` 404s on the row lookup, and
 * `assertAgentReferencesMcpServer` / `assertAgentDeclaresIntegration` have no
 * manifest to walk. Its authorization is the launcher-published
 * {@link ConnectRunGrant} instead — one integration, one mcp-server, one
 * concrete version.
 *
 * Every test below names the source mutation it catches, because a suite that
 * only asserts refusals passes trivially on a route that refuses everything.
 * The acceptance controls (the first test in each describe, plus the run-token
 * regression) are what keep the deny cases honest.
 *
 * These tests drive the REAL router with a REAL grant store (the tier-0
 * in-memory `KeyValueCache`), which is what
 * `runtime-pi/sidecar/test/connect-run-spec-contract.test.ts` cannot do — it
 * drives a fake platform whose `fetch` answers 200 unconditionally, which is
 * exactly why this gap survived.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import {
  writeConnectRunGrant,
  deleteConnectRunGrant,
  readConnectRunGrant,
  CONNECT_ID_PREFIX,
  connectRunGrantTtlSeconds,
  type ConnectRunGrant,
} from "../../../src/services/connect/connect-run-grant.ts";
import {
  localIntegrationManifest,
  mcpServerManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { installPackage } from "../../../src/services/space-packages.ts";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { db } from "../../helpers/db.ts";
import { integrationConnections } from "@appstrate/db/schema";

const BUCKET = "agent-packages";
const app = getTestApp();

const AGENT = "@grantorg/test-agent";
const INTEGRATION = "@grantorg/local-integ";
const OTHER_INTEGRATION = "@grantorg/other-integ";
const MCP_SERVER = "@grantorg/local-server";
const OTHER_SERVER = "@grantorg/other-server";

const SERVER_VERSION = "1.0.0";
const OTHER_VERSION = "2.0.0";
const SERVER_BYTES = new TextEncoder().encode("PK-granted-server-bytes-marker");
const OTHER_BYTES = new TextEncoder().encode("PK-other-server-bytes-marker");

/** Mint a connect-run id the same way `connect-run-launcher.ts` does. */
function newConnectId(): string {
  return `${CONNECT_ID_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

describe("/internal/* — connect-run grant authorization", () => {
  let ctx: TestContext;
  /** Real run + its token: the regression control for the untouched run path. */
  let runId: string;
  let runToken: string;
  /** Connect run granted (INTEGRATION, MCP_SERVER@1.0.0). */
  let connectId: string;
  let connectToken: string;
  const mintedConnectIds: string[] = [];

  async function grant(id: string, over: Partial<ConnectRunGrant> = {}): Promise<void> {
    mintedConnectIds.push(id);
    await writeConnectRunGrant(
      id,
      {
        orgId: ctx.orgId,
        integrationId: INTEGRATION,
        mcpServerId: MCP_SERVER,
        mcpServerVersion: SERVER_VERSION,
        ...over,
      },
      connectRunGrantTtlSeconds(60_000),
    );
  }

  async function seedIntegrationPackage(id: string, serverName: string, installed: boolean) {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: id,
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
      await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id);
    }
  }

  /** Publish one downloadable version of an already-seeded mcp-server package. */
  async function seedServerVersion(id: string, version: string, bytes: Uint8Array) {
    await storage.uploadFile(BUCKET, `${id}/${version}.afps`, Buffer.from(bytes));
    await seedPackageVersion({
      packageId: id,
      version,
      integrity: computeIntegrity(bytes),
      artifactSize: bytes.length,
      manifest: mcpServerManifest({ name: id, version }),
    });
  }

  async function seedServer(id: string, version: string, bytes: Uint8Array) {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: mcpServerManifest({ name: id, version }),
    });
    await seedServerVersion(id, version, bytes);
  }

  /** A live, decryptable credential for INTEGRATION owned by the test user. */
  async function seedLiveConnection(integrationId: string) {
    await db.insert(integrationConnections).values({
      integrationId,
      authKey: "primary",
      accountId: "acct-test",
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({
        outputs: { api_key: "live-secret-value" },
      }),
      scopesGranted: [],
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "grantorg" });

    // The agent declares INTEGRATION (→ MCP_SERVER) so the RUN path has a real
    // ALLOW of its own to defend. It never declares OTHER_INTEGRATION.
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: "Grant Test Agent",
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
      },
    });
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    await seedIntegrationPackage(INTEGRATION, MCP_SERVER, true);
    await seedIntegrationPackage(OTHER_INTEGRATION, OTHER_SERVER, true);
    await seedServer(MCP_SERVER, SERVER_VERSION, SERVER_BYTES);
    await seedServer(OTHER_SERVER, OTHER_VERSION, OTHER_BYTES);

    const run = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
    });
    runId = run.id;
    runToken = signRunToken(runId);

    connectId = newConnectId();
    connectToken = signRunToken(connectId);
    await grant(connectId);
  });

  afterEach(async () => {
    // The grant store is process-wide (not a DB table), so `truncateAll` does
    // not clear it — leaking one would let a later test pass on a stale grant.
    for (const id of mintedConnectIds.splice(0)) await deleteConnectRunGrant(id);
  });

  // ─── GET /internal/mcp-server-bundle ───────────────────────────────────

  describe("GET /internal/mcp-server-bundle", () => {
    it("ACCEPTANCE: a connect token fetches ITS OWN granted mcp-server bundle", async () => {
      // Catches: deleting the connect branch from the byte route (the request
      // falls through to `verifyRunToken`, which 404s on the missing `runs`
      // row — the pre-existing bug this whole change closes). Also catches a
      // grant that is never written, or written after `createSidecar`.
      const res = await app.request(
        `/internal/mcp-server-bundle/${MCP_SERVER}?version=${SERVER_VERSION}`,
        { headers: { Authorization: `Bearer ${connectToken}` } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/zip");
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(SERVER_BYTES));
    });

    it("DENY: the same connect token cannot fetch a DIFFERENT mcp-server's bundle", async () => {
      // Catches: dropping the `grant.mcpServerId !== mcpServerId` comparison,
      // or weakening it to a prefix/`includes` match. OTHER_SERVER is a real,
      // downloadable package in the same org — the only thing refusing it is
      // the grant.
      const res = await app.request(
        `/internal/mcp-server-bundle/${OTHER_SERVER}?version=${OTHER_VERSION}`,
        { headers: { Authorization: `Bearer ${connectToken}` } },
      );
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toMatch(/not the server this connect run resolved/i);
    });

    it("DENY: the granted package at a version the grant does not name", async () => {
      // Catches: matching only on package id and letting `?version=` through,
      // which would turn "one concrete version" into "any version of this
      // package" — the #588 manifest/bytes skew, reopened for connect runs.
      await seedServerVersion(MCP_SERVER, "9.9.9", OTHER_BYTES);
      const res = await app.request(`/internal/mcp-server-bundle/${MCP_SERVER}?version=9.9.9`, {
        headers: { Authorization: `Bearer ${connectToken}` },
      });
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toMatch(/is not the version this connect run/i);
    });

    it("DENY: a system grant (version null) refuses a ?version= rather than reaching the DB", async () => {
      // Catches: treating `mcpServerVersion: null` as "no version constraint".
      // The null case exists ONLY for the boot-registry short-circuit; if it
      // fell through to the `package_versions` lookup, a system grant would
      // read any published version of the named package.
      const sysConnectId = newConnectId();
      await grant(sysConnectId, { mcpServerVersion: null });
      const res = await app.request(
        `/internal/mcp-server-bundle/${MCP_SERVER}?version=${SERVER_VERSION}`,
        { headers: { Authorization: `Bearer ${signRunToken(sysConnectId)}` } },
      );
      expect(res.status).toBe(404);
    });

    it("DENY: the granted package id, resolved in ANOTHER org's tenant", async () => {
      // `grant.orgId` is a real comparison, not decoration: the grant carries
      // the org the launcher's org-scoped resolver ran in, and the version
      // lookup now filters by the org owning the row AT FETCH TIME. This is
      // the skew that gap admits — a package id deleted and recreated under a
      // different tenant between grant-write and byte-fetch — reproduced here
      // by resolving a package the granted org does not own.
      //
      // Catches: dropping the `orgOrSystemFilter` from the version lookup,
      // i.e. restoring the unfiltered `eq(packageId) + eq(version)` query that
      // had no tenant boundary at all.
      const foreign = await createTestContext({ orgSlug: "grantorg-foreign" });
      const FOREIGN_SERVER = "@grantorg-foreign/local-server";
      const FOREIGN_BYTES = new TextEncoder().encode("PK-foreign-tenant-bytes-marker");
      await seedPackage({
        id: FOREIGN_SERVER,
        orgId: foreign.orgId,
        type: "mcp-server",
        source: "local",
        draftManifest: mcpServerManifest({ name: FOREIGN_SERVER, version: SERVER_VERSION }),
      });
      await seedServerVersion(FOREIGN_SERVER, SERVER_VERSION, FOREIGN_BYTES);

      // The grant NAMES the foreign package (so the id match passes) but
      // carries OUR org — only the tenant filter can refuse this.
      const crossId = newConnectId();
      await grant(crossId, { mcpServerId: FOREIGN_SERVER });

      const res = await app.request(
        `/internal/mcp-server-bundle/${FOREIGN_SERVER}?version=${SERVER_VERSION}`,
        { headers: { Authorization: `Bearer ${signRunToken(crossId)}` } },
      );
      expect(res.status).toBe(404);
    });

    it("ALLOW: a SYSTEM-owned mcp-server row (org_id NULL) stays reachable", async () => {
      // The control that keeps the tenant filter from being over-tight.
      // `orgOrSystemFilter` admits `org_id IS NULL`, matching the org-scoped
      // resolver that wrote the grant — a system mcp-server is legitimately
      // not owned by the connect run's org. Without this, the DENY above would
      // pass just as well on a filter that refused everything it did not own.
      //
      // This row is NOT in the boot registry (`getTestApp()` skips `boot()`),
      // so the request goes through the `package_versions` lookup rather than
      // the in-memory short-circuit — the code path under test.
      const SYS_SERVER = "@appstrate/sys-server";
      const SYS_BYTES = new TextEncoder().encode("PK-system-owned-bytes-marker");
      await seedPackage({
        id: SYS_SERVER,
        orgId: null,
        type: "mcp-server",
        source: "local",
        draftManifest: mcpServerManifest({ name: SYS_SERVER, version: SERVER_VERSION }),
      });
      await seedServerVersion(SYS_SERVER, SERVER_VERSION, SYS_BYTES);

      const sysId = newConnectId();
      await grant(sysId, { mcpServerId: SYS_SERVER });

      const res = await app.request(
        `/internal/mcp-server-bundle/${SYS_SERVER}?version=${SERVER_VERSION}`,
        { headers: { Authorization: `Bearer ${signRunToken(sysId)}` } },
      );
      expect(res.status).toBe(200);
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(SYS_BYTES));
    });

    it("DENY: a connect token with NO grant", async () => {
      // Catches: falling back to any other authorization when the grant is
      // absent, and any "trust the signature alone" shortcut.
      await deleteConnectRunGrant(connectId);
      const res = await app.request(
        `/internal/mcp-server-bundle/${MCP_SERVER}?version=${SERVER_VERSION}`,
        { headers: { Authorization: `Bearer ${connectToken}` } },
      );
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toMatch(/connect run not found/i);
    });

    it("DENY: a connect token whose grant has EXPIRED", async () => {
      // Catches: writing the grant with no TTL (or an unbounded one), which
      // would leave a leaked connect token useful forever. Uses a real
      // 1-second TTL against the real cache adapter, not a stubbed clock.
      const expiringId = newConnectId();
      mintedConnectIds.push(expiringId);
      await writeConnectRunGrant(
        expiringId,
        {
          orgId: ctx.orgId,
          integrationId: INTEGRATION,
          mcpServerId: MCP_SERVER,
          mcpServerVersion: SERVER_VERSION,
        },
        1,
      );
      // Positive control FIRST: the same grant authorises while it is alive,
      // so the refusal below cannot be an artefact of a bad fixture.
      expect(await readConnectRunGrant(expiringId)).not.toBeNull();
      await Bun.sleep(1100);
      expect(await readConnectRunGrant(expiringId)).toBeNull();

      const res = await app.request(
        `/internal/mcp-server-bundle/${MCP_SERVER}?version=${SERVER_VERSION}`,
        { headers: { Authorization: `Bearer ${signRunToken(expiringId)}` } },
      );
      expect(res.status).toBe(404);
    });

    it("REGRESSION: a real run token still reaches its agent's mcp-server, and only that one", async () => {
      // The control that keeps every DENY above honest, and the guard on
      // "the real-run path must not widen or narrow by one inch": catches a
      // connect branch that swallows run tokens, and catches replacing
      // `assertAgentReferencesMcpServer` instead of adding beside it.
      const allowed = await app.request(
        `/internal/mcp-server-bundle/${MCP_SERVER}?version=${SERVER_VERSION}`,
        { headers: { Authorization: `Bearer ${runToken}` } },
      );
      expect(allowed.status).toBe(200);
      expect(Array.from(new Uint8Array(await allowed.arrayBuffer()))).toEqual(
        Array.from(SERVER_BYTES),
      );

      const denied = await app.request(
        `/internal/mcp-server-bundle/${OTHER_SERVER}?version=${OTHER_VERSION}`,
        { headers: { Authorization: `Bearer ${runToken}` } },
      );
      expect(denied.status).toBe(404);
      expect(JSON.stringify(await denied.json())).toMatch(/not referenced by the running agent/i);
    });

    it("CROSS: a grant cannot widen a RUN token — the run path never reads one", async () => {
      // Catches: keying the grant on something a run token could also present,
      // or resolving the grant before knowing which population the id is in.
      // A live grant naming OTHER_SERVER exists; the run token must still be
      // judged solely by its agent's dependencies.
      const otherConnectId = newConnectId();
      await grant(otherConnectId, { mcpServerId: OTHER_SERVER, mcpServerVersion: OTHER_VERSION });
      // ...and one keyed by the RUN's own id, the most direct smuggling attempt.
      await writeConnectRunGrant(
        `${CONNECT_ID_PREFIX}${runId}`,
        {
          orgId: ctx.orgId,
          integrationId: OTHER_INTEGRATION,
          mcpServerId: OTHER_SERVER,
          mcpServerVersion: OTHER_VERSION,
        },
        60,
      );
      mintedConnectIds.push(`${CONNECT_ID_PREFIX}${runId}`);

      const res = await app.request(
        `/internal/mcp-server-bundle/${OTHER_SERVER}?version=${OTHER_VERSION}`,
        { headers: { Authorization: `Bearer ${runToken}` } },
      );
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toMatch(/not referenced by the running agent/i);
    });

    it("CROSS: a connect token cannot borrow the RUN branch's agent-manifest authorization", async () => {
      // The mirror image: the agent DOES reference MCP_SERVER, and a run token
      // is allowed it (asserted above). A connect token granted OTHER_SERVER
      // must not inherit that — catches a branch that falls through to
      // `assertAgentReferencesMcpServer` when the grant check fails.
      const narrowId = newConnectId();
      await grant(narrowId, { mcpServerId: OTHER_SERVER, mcpServerVersion: OTHER_VERSION });
      const res = await app.request(
        `/internal/mcp-server-bundle/${MCP_SERVER}?version=${SERVER_VERSION}`,
        { headers: { Authorization: `Bearer ${signRunToken(narrowId)}` } },
      );
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toMatch(/not the server this connect run resolved/i);
    });

    it("a forged connect token (right shape, no signature) is still 401", async () => {
      // Catches: branching on the RAW bearer's prefix instead of on the
      // VERIFIED id, which would let anyone mint `connect_<id>` for a grant id
      // they guessed.
      const res = await app.request(
        `/internal/mcp-server-bundle/${MCP_SERVER}?version=${SERVER_VERSION}`,
        { headers: { Authorization: `Bearer ${connectId}.deadbeef` } },
      );
      expect(res.status).toBe(401);
    });
  });

  // ─── the rest of the /internal surface ─────────────────────────────────

  it("a live grant opens NO other /internal endpoint", async () => {
    // The grant is scoped to the two surfaces a connect run actually calls
    // (pinned from the sidecar side in
    // `runtime-pi/sidecar/test/connect-run-spec-contract.test.ts`). Everything
    // else on `/internal/*` still runs `verifyRunToken` alone, which finds no
    // `runs` row for a connect id. Catches: hoisting the connect branch into a
    // router-wide middleware, or teaching `verifyRunToken` about connect ids.
    for (const path of [
      "/internal/run-history",
      "/internal/memories",
      "/internal/oauth-token/some-credential-id",
    ]) {
      const res = await app.request(path, {
        headers: { Authorization: `Bearer ${connectToken}` },
      });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(JSON.stringify(await res.json())).toMatch(/run not found/i);
    }
  });

  // ─── GET/POST /internal/integration-credentials ────────────────────────

  describe("/internal/integration-credentials", () => {
    it("ACCEPTANCE: a connect token reads its granted integration's surface — and it is EMPTY", async () => {
      // Catches BOTH failure directions at once. Without the connect branch
      // this 404s (`verifyRunToken` — the wall the connect run hits FIRST, one
      // call before the bundle fetch). With a branch that resolved LIVE
      // credentials it would hand this token a plaintext secret it has no use
      // for: a connect run exists to MINT the credential, and its login secret
      // arrives via CONNECT_LOGIN_JSON, never from here.
      await seedLiveConnection(INTEGRATION);
      const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
        headers: { Authorization: `Bearer ${connectToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        auths: unknown[];
        delivery_plans: Record<string, unknown>;
      };
      expect(body.auths).toEqual([]);
      expect(body.delivery_plans).toEqual({});
      expect(JSON.stringify(body)).not.toContain("live-secret-value");
    });

    it("DENY: the same connect token cannot read a DIFFERENT integration's credentials", async () => {
      // Catches: dropping `assertConnectGrantCoversIntegration`. OTHER_INTEGRATION
      // is installed and holds a live connection — only the grant refuses it.
      await seedLiveConnection(OTHER_INTEGRATION);
      const res = await app.request(`/internal/integration-credentials/${OTHER_INTEGRATION}`, {
        headers: { Authorization: `Bearer ${connectToken}` },
      });
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toMatch(
        /not the integration this connect run connects/i,
      );
    });

    it("DENY: a connect token with no grant", async () => {
      await deleteConnectRunGrant(connectId);
      const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
        headers: { Authorization: `Bearer ${connectToken}` },
      });
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toMatch(/connect run not found/i);
    });

    it("REGRESSION: a real run token still gets the LIVE credentials payload", async () => {
      // The acceptance control for the credentials route: proves the empty
      // payload above is a connect-branch decision, not the route going blind.
      await seedLiveConnection(INTEGRATION);
      const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
        headers: { Authorization: `Bearer ${runToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { auths: { fields: Record<string, string> }[] };
      expect(body.auths).toHaveLength(1);
      expect(body.auths[0]!.fields.api_key).toBe("live-secret-value");
    });

    it("POST /refresh is refused for a connect token — there is nothing to refresh", async () => {
      // Catches: leaving the refresh POST to fall into "Run not found", which
      // names the wrong cause, and catches a branch that returned 200-empty
      // here (the sidecar would then retry the upstream call with no header).
      await seedLiveConnection(INTEGRATION);
      const res = await app.request(`/internal/integration-credentials/${INTEGRATION}/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${connectToken}` },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("connect_run_no_refresh");
    });

    it("POST /refresh still works for a real run token", async () => {
      // Regression control for the refresh branch: an api_key auth is
      // unrefreshable, so the resolver flags the connection and answers 410 —
      // the same terminal answer it gave before this change, reached through
      // the untouched run path.
      await seedLiveConnection(INTEGRATION);
      const res = await app.request(`/internal/integration-credentials/${INTEGRATION}/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runToken}` },
      });
      expect(res.status).toBe(410);
    });
  });
});
