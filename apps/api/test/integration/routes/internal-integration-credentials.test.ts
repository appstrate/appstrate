// SPDX-License-Identifier: Apache-2.0

/**
 * GET /internal/integration-credentials/:scope/:name (+ /refresh) —
 * fail-closed authorization on the most credential-sensitive endpoint
 * in the platform.
 *
 * The sidecar fetches live decrypted credentials here to inject into
 * outbound integration calls (the MITM credential boundary). The route
 * is authorised by the per-run Bearer token AND
 * `assertAgentDeclaresIntegration`, which verifies the running agent
 * declares the integration as a dependency AND it is installed in the
 * run's space. A leaked run token must not be able to enumerate
 * arbitrary integration secrets across the org.
 *
 * Mirrors the structure of `internal-mcp-server-bundle.test.ts`. Deep
 * OAuth refresh semantics (invalid_grant → 410, transient → 502,
 * scope-shrink behaviour) live in the service-level test
 * `services/integration-credentials-resolver.test.ts`. This file pins
 * the HTTP route boundary: auth, dep, install, the `connection_id` selector,
 * response shape.
 *
 * The endpoint is per-CONNECTION: a run binds a SET of connections to an
 * integration (`runs.resolved_connections`), so every request names one with
 * `?connection_id=` and the snapshot is the third authorization layer.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedPackage,
  seedPackageShare,
  seedPackageVersion,
  seedRun,
} from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { integrationConnections, packages, runs } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const app = getTestApp();

const AGENT = "@credsorg/test-agent";
const INTEGRATION = "@credsorg/svc";
const OTHER_INTEGRATION = "@credsorg/other-svc";
const MCP_SERVER = "@credsorg/svc-server";

function buildAgentManifest(declaredIntegrations: string[]): Record<string, unknown> {
  const deps: Record<string, string> = {};
  const sel: Record<string, { tools?: string[] }> = {};
  for (const id of declaredIntegrations) {
    deps[id] = "^1.0.0";
    sel[id] = { tools: ["search"] };
  }
  return {
    name: AGENT,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    display_name: "Creds Test Agent",
    dependencies: { integrations: deps },
    integrations: sel,
  };
}

function buildIntegrationManifest(id: string) {
  return localIntegrationManifest({
    name: id,
    serverName: MCP_SERVER,
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
  });
}

/**
 * The endpoint is per-CONNECTION: a run binds a set of connections to an
 * integration and names the one it wants. Both halves are required — the query
 * param AND the run's kickoff snapshot authorising it.
 */
function credentialsUrl(integrationId: string, connectionId: string, refresh = false): string {
  return (
    `/internal/integration-credentials/${integrationId}${refresh ? "/refresh" : ""}` +
    `?connection_id=${connectionId}`
  );
}

/** Write the kickoff snapshot the cascade would have written for this run. */
async function bindConnectionsToRun(
  runIdToBind: string,
  bindings: Record<string, string[]>,
): Promise<void> {
  const resolved: Record<string, { connectionId: string; source: "member_pin" }[]> = {};
  for (const [integrationId, ids] of Object.entries(bindings)) {
    resolved[integrationId] = ids.map((connectionId) => ({
      connectionId,
      source: "member_pin" as const,
    }));
  }
  await db.update(runs).set({ resolvedConnections: resolved }).where(eq(runs.id, runIdToBind));
}

describe("GET /internal/integration-credentials/:scope/:name", () => {
  let ctx: TestContext;
  let runId: string;
  let token: string;

  async function seedIntegration(id: string, installed: boolean) {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(id),
    });
    if (installed) {
      await seedPackageShare(ctx.defaultSpaceId, id);
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id);
    }
  }

  /**
   * Seed a connection for the test user with an explicit auth key + blob. The
   * label is distinct per call: several tests below bind TWO connections of the
   * same integration to one run, and the label is what tells them apart.
   */
  let seededConnections = 0;
  async function seedConnectionRow(
    integrationId: string,
    opts: { authKey?: string; credentialsEncrypted?: string } = {},
  ): Promise<string> {
    const label = `acct-test-${++seededConnections}`;
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: integrationId,
        authKey: opts.authKey ?? "primary",
        accountId: label,
        label,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        endUserId: null,
        credentialsEncrypted:
          opts.credentialsEncrypted ??
          encryptCredentialEnvelope({ outputs: { api_key: "live-secret-value" } }),
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  /** Seed an api_key connection for the test user on the given integration. */
  async function seedConnection(integrationId: string) {
    await seedConnectionRow(integrationId);
  }

  /** A connection created against an auth key the manifest no longer declares. */
  async function seedConnectionWithAuthKey(
    integrationId: string,
    authKey: string,
  ): Promise<string> {
    return seedConnectionRow(integrationId, { authKey });
  }

  /**
   * A connection whose ciphertext no key in this deployment can open — what a
   * rotated `CONNECTION_ENCRYPTION_KEY` (or a corrupted blob) leaves behind.
   */
  async function seedUndecryptableConnection(integrationId: string): Promise<string> {
    return seedConnectionRow(integrationId, { credentialsEncrypted: "v1:not-a-real-envelope" });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "credsorg" });

    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);

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

  // ─── Auth boundary ─────────────────────────────────────

  it("returns 401 without a run token", async () => {
    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`);
    expect(res.status).toBe(401);
  });

  it("returns 401 with a forged run token", async () => {
    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  // ─── Dep-and-install gate ──────────────────────────────

  it("DENY: 404 when the integration is NOT declared by the running agent", async () => {
    // OTHER_INTEGRATION exists + is installed, but the agent doesn't depend on it.
    // A leaked run token from AGENT must not be able to enumerate OTHER's creds.
    await seedIntegration(INTEGRATION, true);
    await seedConnection(INTEGRATION);
    await seedIntegration(OTHER_INTEGRATION, true);
    await seedConnection(OTHER_INTEGRATION);

    const res = await app.request(`/internal/integration-credentials/${OTHER_INTEGRATION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    // ApiError serialises detail/title with the integration id mentioned.
    expect(JSON.stringify(body)).toMatch(/not a dependency/i);
  });

  it("DENY: 404 when the integration is declared but NOT active in the space", async () => {
    // The dep is declared, but `space_packages` row is absent.
    // The gate refuses — install is a separate authorization layer.
    await seedIntegration(INTEGRATION, false);
    await seedConnection(INTEGRATION);

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/not active in this space/i);
  });

  // ─── Happy path ────────────────────────────────────────

  it("ALLOW: returns the live credentials payload for a declared + installed integration", async () => {
    await seedIntegration(INTEGRATION, true);
    const connectionId = await seedConnectionRow(INTEGRATION);
    await bindConnectionsToRun(runId, { [INTEGRATION]: [connectionId] });

    const res = await app.request(credentialsUrl(INTEGRATION, connectionId), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auths: Array<{ auth_key: string; auth_type: string; fields: Record<string, string> }>;
      delivery_plans: Record<string, unknown>;
    };
    expect(body.auths).toHaveLength(1);
    expect(body.auths[0]!.auth_key).toBe("primary");
    expect(body.auths[0]!.auth_type).toBe("api_key");
    // Decrypted credential payload reaches the sidecar — this IS the surface.
    expect(body.auths[0]!.fields.api_key).toBe("live-secret-value");
    // Delivery plan derived from manifest.auths.primary.delivery.http.
    expect(body.delivery_plans.primary).toBeDefined();
  });

  // NOTE — a RUN token never gets an empty payload from this endpoint. The
  // zero-auth branch that used to produce one is gone: `@afps-spec/schema`
  // requires every integration to declare at least one auth ("integration MUST
  // declare at least one auth method"), so a zero-auth manifest fails
  // validation on read and this endpoint answers 500 `invalid_manifest` long
  // before any resolver code. The one empty payload that remains belongs to the
  // CONNECT-run branch, which never reaches the resolver — it is covered in
  // `internal-connect-run-grant.test.ts`.

  // ─── Fail-loud: the three states that used to answer 200-with-empty ───
  //
  // All three returned the byte-identical payload the no-auth case above
  // returns, so the sidecar skipped the MITM listener, the agent's tools ran
  // uncredentialed, and every upstream call 401'd — reported by the agent as a
  // generic "the API is unavailable", indistinguishable from a real outage.

  it("DENY: 404 when the connection this run bound is no longer reachable", async () => {
    // STATE A. The run bound a connection at kickoff and it went away
    // (deleted, unshared, moved). Nothing to inject for THAT connection.
    await seedIntegration(INTEGRATION, true);
    const connectionId = await seedConnectionRow(INTEGRATION);
    await bindConnectionsToRun(runId, { [INTEGRATION]: [connectionId] });
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId));

    const res = await app.request(credentialsUrl(INTEGRATION, connectionId), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail?: string };
    // Cause AND remedy — naming the integration AND which of its connections,
    // because a run can bind several and only one of them is gone.
    expect(body.detail).toContain("no longer reachable");
    expect(body.detail).toContain(INTEGRATION);
    expect(body.detail).toContain(connectionId);
    expect(body.detail).toMatch(/relaunch the run/i);
  });

  // ─── The connection selector (plan §8 row 8) ───
  //
  // A run may bind several connections to one integration, so the caller
  // names one and the run's kickoff snapshot is what authorises it. Both
  // refusals are 400: a request that cannot say which connection it means gets
  // no guess, and one naming a connection this run never bound is asking for a
  // credential its run token does not cover.

  it("DENY: 400 when `connection_id` is absent", async () => {
    await seedIntegration(INTEGRATION, true);
    const connectionId = await seedConnectionRow(INTEGRATION);
    await bindConnectionsToRun(runId, { [INTEGRATION]: [connectionId] });

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { param?: string; detail?: string };
    expect(body.param).toBe("connection_id");

    // CONTROL — the very same run, integration and connection answer 200 as
    // soon as the caller names it.
    const ok = await app.request(credentialsUrl(INTEGRATION, connectionId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
  });

  it("DENY: 400 connection_not_in_run for a connection this run did not bind", async () => {
    await seedIntegration(INTEGRATION, true);
    const bound = await seedConnectionRow(INTEGRATION);
    // A second, real connection on the same integration and the same actor —
    // accessible, decryptable, and simply not part of THIS run's set.
    const unbound = await seedConnectionRow(INTEGRATION);
    await bindConnectionsToRun(runId, { [INTEGRATION]: [bound] });

    const res = await app.request(credentialsUrl(INTEGRATION, unbound), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("connection_not_in_run");
    expect(body.detail).toContain(unbound);

    // CONTROL — the bound sibling resolves, so the refusal is about the
    // binding and not about the connection being unusable.
    const ok = await app.request(credentialsUrl(INTEGRATION, bound), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
  });

  it("DENY: 400 for a syntactically invalid `connection_id`", async () => {
    await seedIntegration(INTEGRATION, true);
    const connectionId = await seedConnectionRow(INTEGRATION);
    await bindConnectionsToRun(runId, { [INTEGRATION]: [connectionId] });

    const res = await app.request(credentialsUrl(INTEGRATION, "not-a-uuid"), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
  });

  // `z.uuid()` accepts `A1B2…` while the snapshot holds what Postgres returned.
  it("ALLOW: an uppercase `connection_id` names the same bound connection", async () => {
    await seedIntegration(INTEGRATION, true);
    const connectionId = await seedConnectionRow(INTEGRATION);
    await bindConnectionsToRun(runId, { [INTEGRATION]: [connectionId] });

    const res = await app.request(credentialsUrl(INTEGRATION, connectionId.toUpperCase()), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
  });

  it("serves EACH bound connection of one integration its own credentials", async () => {
    // The whole point of the set: two connections, one integration, one run —
    // two distinct credential surfaces under the same `packageId`.
    await seedIntegration(INTEGRATION, true);
    const first = await seedConnectionRow(INTEGRATION, {
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret-one" } }),
    });
    const second = await seedConnectionRow(INTEGRATION, {
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret-two" } }),
    });
    await bindConnectionsToRun(runId, { [INTEGRATION]: [first, second] });

    const read = async (connectionId: string): Promise<string | undefined> => {
      const res = await app.request(credentialsUrl(INTEGRATION, connectionId), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { auths: Array<{ fields: Record<string, string> }> };
      return body.auths[0]?.fields.api_key;
    };

    expect(await read(first)).toBe("secret-one");
    expect(await read(second)).toBe("secret-two");
  });

  it("DENY: 409 integration_auth_undeclared when the pinned manifest dropped the connection's auth", async () => {
    // STATE B. The connection exists and decrypts, but it was created against
    // an auth key the manifest no longer declares (renamed/removed). Pinned via
    // `runs.resolved_connections` — that is the only selection path that can
    // return a row whose authKey is not in the declared set.
    await seedIntegration(INTEGRATION, true);
    const connectionId = await seedConnectionWithAuthKey(INTEGRATION, "legacy_primary");
    const pinnedRun = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
      resolvedConnections: { [INTEGRATION]: [{ connectionId, source: "member_pin" }] },
    });

    const res = await app.request(credentialsUrl(INTEGRATION, connectionId), {
      headers: { Authorization: `Bearer ${signRunToken(pinnedRun.id)}` },
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("integration_auth_undeclared");
    // Names the undeclared key AND what the manifest does declare. The
    // declared-auths list needs its prefix: a bare `toContain("primary")` is
    // satisfied by the `legacy_primary` substring and proves nothing.
    expect(body.detail).toContain("legacy_primary");
    expect(body.detail).toContain("declared auths: primary");
    // The credential is intact — a manifest edit must never destroy it.
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    expect(row!.needsReconnection).toBe(false);
  });

  it("DENY: 410 + flags + records when the stored credentials cannot be decrypted", async () => {
    // STATE C. A credential nobody can read is dead on ANY read, forced or
    // not: flag the connection, stamp the run, refuse. The boot GET is where
    // this state actually surfaces (the sidecar fetches once at spawn).
    await seedIntegration(INTEGRATION, true);
    const connectionId = await seedUndecryptableConnection(INTEGRATION);
    await bindConnectionsToRun(runId, { [INTEGRATION]: [connectionId] });

    const res = await app.request(credentialsUrl(INTEGRATION, connectionId), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(410);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("INTEGRATION_CONNECTION_NEEDS_RECONNECTION");
    expect(body.detail).toMatch(/could not be decrypted/i);

    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    expect(row!.needsReconnection).toBe(true);

    // The GET now records the terminal failure on the run too — a boot-time
    // 410 the run never records is a failure only the transcript reveals.
    const [runRow] = await db.select().from(runs).where(eq(runs.id, runId));
    const meta = runRow!.metadata as { degraded_integrations?: string[] } | null;
    expect(meta?.degraded_integrations).toContain(INTEGRATION);
  });
});

describe("POST /internal/integration-credentials/:scope/:name/refresh", () => {
  let ctx: TestContext;
  let runId: string;
  let token: string;

  async function seedIntegration(id: string, installed: boolean) {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(id),
    });
    if (installed) {
      await seedPackageShare(ctx.defaultSpaceId, id);
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id);
    }
  }

  async function seedConnection(integrationId: string): Promise<string> {
    const ciphertext = encryptCredentialEnvelope({ outputs: { api_key: "live-secret-value" } });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: integrationId,
        authKey: "primary",
        accountId: "acct-test",
        label: "acct-test",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        endUserId: null,
        credentialsEncrypted: ciphertext,
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "refresh" });

    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);

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

  // ─── Auth boundary (mirror of GET) ─────────────────────

  it("returns 401 without a run token", async () => {
    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}/refresh`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  // ─── Dep-and-install gate ──────────────────────────────

  it("DENY: 404 when the integration is NOT declared by the running agent", async () => {
    await seedIntegration(OTHER_INTEGRATION, true);
    await seedConnection(OTHER_INTEGRATION);

    const res = await app.request(
      `/internal/integration-credentials/${OTHER_INTEGRATION}/refresh`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(404);
  });

  it("DENY: 404 when the integration is declared but NOT active in the space", async () => {
    await seedIntegration(INTEGRATION, false);
    await seedConnection(INTEGRATION);

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
  });

  // ─── Terminal on a non-OAuth auth (the unified flagging path) ──

  it("flags needsReconnection + records run metadata + 410 for a non-OAuth auth on a forced refresh", async () => {
    // A forced /refresh only happens after an upstream 401. A non-OAuth
    // (api_key) credential cannot be refreshed → it is dead → the route flags
    // the connection, stamps the run's degraded_integrations, and returns 410
    // (the sidecar maps that to "don't retry"). This is the single place a
    // terminal auth failure is recorded — no separate report endpoint.
    await seedIntegration(INTEGRATION, true);
    const connectionId = await seedConnection(INTEGRATION);
    await bindConnectionsToRun(runId, { [INTEGRATION]: [connectionId] });

    const res = await app.request(credentialsUrl(INTEGRATION, connectionId, true), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(410);

    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION));
    expect(row!.needsReconnection).toBe(true);

    const [runRow] = await db.select().from(runs).where(eq(runs.id, runId));
    const meta = runRow!.metadata as { degraded_integrations?: string[] } | null;
    expect(meta?.degraded_integrations).toContain(INTEGRATION);
  });

  it("DENY: 400 without `connection_id` — the selector guards BOTH routes", async () => {
    // Control for the test above: same seed, same run, same token — only the
    // selector is missing, and the refresh never reaches the credential.
    await seedIntegration(INTEGRATION, true);
    const connectionId = await seedConnection(INTEGRATION);
    await bindConnectionsToRun(runId, { [INTEGRATION]: [connectionId] });

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    // A refused request must not have touched the credential it never read.
    expect(row!.needsReconnection).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Version-pinned runs — the dep guard reads the EFFECTIVE manifest.
//
// `assertAgentDeclaresIntegration` must authorize against the definition the
// run EXECUTES (`runs.version_ref` → `package_versions` snapshot), never the
// mutable draft. Regression for the @tractr/fathom-glenn incident: a dep
// removed from the draft after publish 404'd the boot credential fetch of a
// scheduled run pinned to a version that still declares it. The reverse
// direction is the security half: a dep newly added to the draft must stay
// out of reach of a run pinned to a version that doesn't declare it.
// ─────────────────────────────────────────────────────────────────────────

describe("GET /internal/integration-credentials — version-pinned runs", () => {
  let ctx: TestContext;

  async function seedIntegration(id: string): Promise<string> {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(id),
    });
    await seedPackageShare(ctx.defaultSpaceId, id);
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id);
    const ciphertext = encryptCredentialEnvelope({ outputs: { api_key: "live-secret-value" } });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: id,
        authKey: "primary",
        accountId: "acct-test",
        label: "acct-test",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        endUserId: null,
        credentialsEncrypted: ciphertext,
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  async function seedPinnedRun(versionRef: string, bindings?: Record<string, string[]>) {
    const run = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
      versionRef,
      // The INSERT-time identity snapshot real kickoff stamps
      // (`extractRunAgentDenorm`). It is what survives when the agent row is
      // deleted mid-run and `runs.package_id` goes NULL.
      agentScope: "credsorg",
      agentName: "Creds Test Agent",
    });
    if (bindings) await bindConnectionsToRun(run.id, bindings);
    return signRunToken(run.id);
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pinnedcreds" });
  });

  it("ALLOW: a dep removed from the draft stays fetchable for a run pinned to a version declaring it", async () => {
    // Draft no longer declares INTEGRATION; published 1.0.0 does.
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([]),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    await seedPackageVersion({
      packageId: AGENT,
      version: "1.0.0",
      manifest: buildAgentManifest([INTEGRATION]),
    });
    const connectionId = await seedIntegration(INTEGRATION);
    const token = await seedPinnedRun("1.0.0", { [INTEGRATION]: [connectionId] });

    const res = await app.request(credentialsUrl(INTEGRATION, connectionId), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { auths: Array<{ fields: Record<string, string> }> };
    expect(body.auths[0]!.fields.api_key).toBe("live-secret-value");
  });

  it("DENY: a dep newly added to the draft is NOT reachable by a run pinned to a version without it", async () => {
    // Draft declares INTEGRATION; published 1.0.0 declares nothing. A leaked
    // run token of the pinned run must not widen to the draft's dep set.
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    await seedPackageVersion({
      packageId: AGENT,
      version: "1.0.0",
      manifest: buildAgentManifest([]),
    });
    await seedIntegration(INTEGRATION);
    const token = await seedPinnedRun("1.0.0");

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toMatch(/not a dependency/i);
  });

  it("a version_ref whose snapshot is gone FAILS LOUD — it never degrades to the draft dep set", async () => {
    // The pinned version row was deleted after kickoff. The draft declares
    // INTEGRATION, so the old draft fallback answered 200 and handed a live run
    // token credentials its pinned definition may never have authorized. The
    // guard now refuses: 409 `run_definition_gone`, naming the deleted version
    // and the package instead of the false "Agent not found".
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    await seedIntegration(INTEGRATION);
    const token = await seedPinnedRun("9.9.9");

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("run_definition_gone");
    // The detail must name the real cause (the deleted pinned version) and the
    // package it belongs to — not the agent row, which is still present.
    expect(body.detail).toContain("9.9.9");
    expect(body.detail).toContain(AGENT);
  });

  it("a run whose AGENT row is gone is refused with the deleted-agent cause, not the deleted-version one", async () => {
    // `runs.package_id` is `ON DELETE SET NULL`, so deleting the agent mid-run
    // leaves the run `running` with a still-valid token — the guard keeps
    // getting hit. It must refuse (the dep set that authorises this fetch is
    // unknowable either way) but name THIS cause: no version will come back, so
    // state A's "re-publish that version" remedy is a lie here.
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    await seedPackageVersion({
      packageId: AGENT,
      version: "1.0.0",
      manifest: buildAgentManifest([INTEGRATION]),
    });
    await seedIntegration(INTEGRATION);
    const token = await seedPinnedRun("1.0.0");

    // Delete the agent itself. The `package_versions` snapshot cascades with
    // it, so the pinned version is unreadable too — the guard must still report
    // the agent, which is the cause that actually explains the other one.
    await db.delete(packages).where(eq(packages.id, AGENT));

    const res = await app.request(`/internal/integration-credentials/${INTEGRATION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("run_agent_deleted");
    // Identity recovered from the INSERT-time snapshot, not a bare `null`.
    expect(body.detail).toContain("@credsorg/Creds Test Agent");
    expect(body.detail).toMatch(/deleted while the run/i);
    // Not state A's message: there is no version to re-publish.
    expect(body.detail).not.toMatch(/re-publish/i);
    expect(body.detail).not.toContain("1.0.0");
  });
});
