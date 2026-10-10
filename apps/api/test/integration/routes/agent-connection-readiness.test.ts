// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/agents/:scope/:name/connection-readiness — bulk integration
 * connection readiness for an agent.
 *
 * Single source of truth behind the launch badge, the Connexions tab pickers,
 * and the pre-run check. The authoritative invariant asserted here:
 *
 *   body.blocks_run === true  ⇔  POST /api/agents/:scope/:name/run → 409
 *
 * plus per-integration `run_blocking` flags and the management `resolution`
 * DTO for every declared integration (even inert ones). Only an integration the
 * agent marks `required` blocks on absence; an optional one is reported unbound.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedOrgModel,
  seedOrgModelProviderKey,
  seedPackage,
  seedPackageVersion,
} from "../../helpers/seed.ts";
import { activatePackage, updateSpacePackage } from "../../../src/services/space-packages.ts";
import { createVersionFromDraft } from "../../../src/services/package-versions.ts";
import { eq } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { integrationConnections, integrationPins, packages } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
  twoAuthApiIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const AGENT = "@rdyorg/agent";
const INTEGRATION = "@rdyorg/svc";
const MCP_SERVER = "@rdyorg/svc-server";

function buildAgentManifest(
  integrations: string[],
  withTools: boolean,
  required = false,
): Record<string, unknown> {
  const deps: Record<string, string> = {};
  const config: Record<string, { tools?: string[]; required?: boolean }> = {};
  for (const id of integrations) {
    deps[id] = "^1.0.0";
    const entry = {
      ...(withTools ? { tools: ["search"] } : {}),
      ...(required ? { required } : {}),
    };
    if (Object.keys(entry).length > 0) config[id] = entry;
  }
  return {
    name: AGENT,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: "Readiness Agent",
    dependencies: { integrations: deps },
    integrations_configuration: config,
  };
}

function buildIntegrationManifest(id: string, required: boolean) {
  const m = localIntegrationManifest({
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
  if (required) {
    (m as unknown as { auths: { primary: Record<string, unknown> } }).auths.primary._meta = {
      "dev.appstrate/auth": { required: true },
    };
  }
  return m;
}

interface ReadinessResolution {
  source: string | null;
  error_code: string | null;
  resolved_connection_ids: string[];
  candidates: Array<{ id: string }>;
}
interface ReadinessBody {
  blocks_run: boolean;
  errors: Array<{
    field: string;
    code: string;
    connection_id?: string;
    required_auth_key?: string;
  }>;
  integrations: Array<{
    integration_package_id: string;
    required: boolean;
    run_blocking: boolean;
    resolution: ReadinessResolution;
  }>;
}

interface DiagnosticsBody {
  status: "healthy" | "warning" | "blocking";
  blocking_count: number;
  warning_count: number;
  can_launch: boolean;
  diagnostics: Array<{
    code: string;
    severity: "blocking" | "warning";
    target: { node: string | null; item: string | null };
    correction: { destination: string; section: string | null };
    recoverable_on_launch: boolean;
  }>;
}

describe("GET /api/agents/:scope/:name/connection-readiness", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "rdyorg" });
  });

  async function seedAgentWith(manifest: Record<string, unknown>) {
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: manifest,
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
  }

  async function seedIntegration(required: boolean) {
    await seedPackage({
      id: INTEGRATION,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(INTEGRATION, required),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);
  }

  async function configureUsableModel() {
    const credential = await seedOrgModelProviderKey({ orgId: ctx.orgId });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: credential.id,
      enabled: true,
    });
    await updateSpacePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT, {
      modelId: model.id,
    });
  }

  async function seedConnection() {
    await db.insert(integrationConnections).values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: "acct-rdy",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret-value" } }),
      scopesGranted: [],
      label: "Readiness",
    });
  }

  /** The two-auth `api_call` integration, and the agent selecting `api_call__primary` of it. */
  async function seedTwoAuthIntegration(config: Record<string, unknown> = {}) {
    await seedAgentWith({
      ...buildAgentManifest([INTEGRATION], false),
      integrations_configuration: { [INTEGRATION]: { tools: ["api_call__primary"], ...config } },
    });
    await seedPackage({
      id: INTEGRATION,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "integration",
      draftManifest: twoAuthApiIntegrationManifest(INTEGRATION),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);
  }

  function getReadiness() {
    return app.request(`/api/agents/${AGENT}/connection-readiness`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
  }

  function getDiagnostics() {
    return app.request(`/api/agents/${AGENT}/diagnostics`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
  }

  function postRun() {
    return app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  it("required integration with no connection → blocks_run + run_blocking, and run 409s (parity)", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], true, true));
    await seedIntegration(false);

    const res = await getReadiness();
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadinessBody;

    expect(body.blocks_run).toBe(true);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.field).toBe(`integrations.${INTEGRATION}`);
    expect(body.errors[0]!.code).toBe("not_connected");

    const integ = body.integrations.find((i) => i.integration_package_id === INTEGRATION);
    expect(integ?.required).toBe(true);
    expect(integ?.run_blocking).toBe(true);
    expect(integ?.resolution).toMatchObject({ source: null, error_code: "not_connected" });

    // Parity: the run gate rejects with 409.
    expect((await postRun()).status).toBe(409);
  });

  it("returns an explicit healthy diagnostics result", async () => {
    await seedAgentWith(buildAgentManifest([], false));
    await configureUsableModel();

    const res = await getDiagnostics();
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiagnosticsBody;
    expect(body).toMatchObject({
      status: "healthy",
      blocking_count: 0,
      warning_count: 0,
      can_launch: true,
      diagnostics: [],
    });
  });

  it("routes a recoverable connection blocker to the toolbox and connections settings", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], true, true));
    await seedIntegration(false);
    await configureUsableModel();

    const res = await getDiagnostics();
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiagnosticsBody;
    expect(body.status).toBe("blocking");
    expect(body.blocking_count).toBe(1);
    expect(body.can_launch).toBe(true);
    expect(body.diagnostics[0]).toMatchObject({
      code: "not_connected",
      severity: "blocking",
      target: { node: "toolbox", item: INTEGRATION },
      correction: { destination: "configuration", section: "connections" },
      recoverable_on_launch: true,
    });
  });

  // Absence degrades: no error, no block, and the entry reads as unbound.
  it("optional integration with no connection → unbound, not blocking, and run passes the gate (parity)", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], true));
    await seedIntegration(false);
    // Published so the launch clears the version freeze that follows the connection gate.
    await seedPackageVersion({
      packageId: INTEGRATION,
      version: "1.0.0",
      manifest: buildIntegrationManifest(INTEGRATION, false) as unknown as Record<string, unknown>,
    });

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(false);
    expect(body.errors).toEqual([]);
    const integ = body.integrations.find((i) => i.integration_package_id === INTEGRATION)!;
    expect(integ.required).toBe(false);
    expect(integ.run_blocking).toBe(false);
    expect(integ.resolution).toMatchObject({
      source: null,
      error_code: null,
      resolved_connection_ids: [],
    });

    // The launch clears the connection gate and dies at the next one (no model is seeded),
    // before any run row exists.
    const run = await postRun();
    expect(run.status).not.toBe(409);
    expect(((await run.json()) as { code?: string }).code).toBe("model_not_configured");
  });

  it("inert OPTIONAL integration (no tools, not required) → present but not blocking", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], false));
    await seedIntegration(false);

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(false);
    expect(body.errors).toHaveLength(0);
    const integ = body.integrations.find((i) => i.integration_package_id === INTEGRATION);
    expect(integ).toBeDefined();
    expect(integ!.run_blocking).toBe(false);
  });

  // A required auth keeps the integration active with no tools; whether its absence blocks is
  // still the agent's `required`.
  it("no tools, required auth, agent requires it → blocks_run + run 409s (parity)", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], false, true));
    await seedIntegration(true);

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(true);
    const integ = body.integrations.find((i) => i.integration_package_id === INTEGRATION);
    expect(integ!.run_blocking).toBe(true);

    expect((await postRun()).status).toBe(409);
  });

  it("no tools, required auth, agent does not require it → unbound, not blocking", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], false));
    await seedIntegration(true);

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(false);
    const integ = body.integrations.find((i) => i.integration_package_id === INTEGRATION)!;
    expect(integ.required).toBe(false);
    expect(integ.run_blocking).toBe(false);
    expect(integ.resolution.error_code).toBeNull();
  });

  it("active integration with one healthy connection → not blocking", async () => {
    await seedAgentWith(buildAgentManifest([INTEGRATION], true));
    await seedIntegration(false);
    await seedConnection();

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(false);
    expect(body.errors).toHaveLength(0);
    const integ = body.integrations.find((i) => i.integration_package_id === INTEGRATION);
    expect(integ!.run_blocking).toBe(false);
    expect(integ!.resolution.resolved_connection_ids).toHaveLength(1);
  });

  // #770 — readiness must assess the SELECTED version's manifest, not always the
  // draft. Published 1.0.0 declares no integrations; the draft adds an active,
  // unconnected one. `?version=1.0.0` must see the frozen (clean) set, while the
  // default (draft) still blocks — otherwise the modal/badge disagree with the run.
  it("?version pins readiness to that published manifest's integration set", async () => {
    // Publish 1.0.0 from a draft with NO integrations → frozen clean.
    await seedAgentWith(buildAgentManifest([], false));
    const published = await createVersionFromDraft({
      packageId: AGENT,
      orgId: ctx.orgId,
      userId: ctx.user.id,
    });
    expect("version" in published && published.version).toBe("1.0.0");

    // Dirty the draft: add a REQUIRED integration with no connection → draft blocks.
    await db
      .update(packages)
      .set({
        draftManifest: buildAgentManifest([INTEGRATION], true, true),
        updatedAt: new Date(Date.now() + 5_000),
      })
      .where(eq(packages.id, AGENT));
    await seedIntegration(false);

    // Default (draft) verdict: the integration is declared, unconnected → blocks.
    const draftBody = (await (await getReadiness()).json()) as ReadinessBody;
    expect(draftBody.blocks_run).toBe(true);
    expect(draftBody.integrations.map((i) => i.integration_package_id)).toContain(INTEGRATION);

    // Pinned 1.0.0 verdict: the frozen manifest has no integrations → clean.
    const verRes = await app.request(`/api/agents/${AGENT}/connection-readiness?version=1.0.0`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
    expect(verRes.status).toBe(200);
    const verBody = (await verRes.json()) as ReadinessBody;
    expect(verBody.blocks_run).toBe(false);
    expect(verBody.integrations).toHaveLength(0);

    // `?version=draft` explicitly is identical to the default (draft) verdict.
    const draftExplicit = await app.request(
      `/api/agents/${AGENT}/connection-readiness?version=draft`,
      { method: "GET", headers: authHeaders(ctx) },
    );
    expect(((await draftExplicit.json()) as ReadinessBody).blocks_run).toBe(true);
  });

  // A pinned set may span the auths of a multi-auth integration, but each
  // member's spec carries only its own auth's api_call tools: a member whose
  // auth serves none of the selection must fail readiness AND kickoff alike.
  it("a pinned member whose auth serves no selected api_call → blocks_run + run 409s (parity)", async () => {
    await seedTwoAuthIntegration();
    const ids: string[] = [];
    for (const [authKey, label] of [
      ["primary", "main"],
      ["backup", "spare"],
    ] as const) {
      const [row] = await db
        .insert(integrationConnections)
        .values({
          integrationId: INTEGRATION,
          authKey,
          accountId: label,
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          userId: ctx.user.id,
          endUserId: null,
          credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
          scopesGranted: [],
          label,
        })
        .returning({ id: integrationConnections.id });
      ids.push(row!.id);
    }
    await db.insert(integrationPins).values({
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT,
      integrationId: INTEGRATION,
      userId: null,
      connectionIds: ids,
    });

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(true);
    expect(body.errors.find((e) => e.field === `integrations.${INTEGRATION}`)).toMatchObject({
      code: "auth_serves_no_selected_tool",
      connection_id: ids[1],
    });
    const integ = body.integrations.find((i) => i.integration_package_id === INTEGRATION);
    // The precise cause and the layer that bound the set, straight from the resolver.
    expect(integ!.resolution).toMatchObject({
      source: "admin_pin",
      error_code: "auth_serves_no_selected_tool",
    });
    expect(integ!.resolution.resolved_connection_ids).toEqual(ids);
    // The picker offers what a `must_choose_connection` 409 would: the serving member only.
    expect(integ!.resolution.candidates.map((c) => c.id)).toEqual([ids[0]!]);

    const run = await postRun();
    expect(run.status).toBe(409);
    const problem = (await run.json()) as { errors: Array<{ field: string; code: string }> };
    const item = problem.errors.find((e) => e.field === `integrations.${INTEGRATION}`);
    expect(item!.code).toBe("auth_serves_no_selected_tool");
  });

  it("required, fallback with only a non-serving connection → not_connected, and no candidate", async () => {
    await seedTwoAuthIntegration({ required: true });
    await db.insert(integrationConnections).values({
      integrationId: INTEGRATION,
      authKey: "backup",
      accountId: "spare",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
      scopesGranted: [],
      label: "spare",
    });

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(true);
    expect(body.errors.find((e) => e.field === `integrations.${INTEGRATION}`)!.code).toBe(
      "not_connected",
    );
    const integ = body.integrations.find((i) => i.integration_package_id === INTEGRATION);
    expect(integ!.resolution).toMatchObject({ source: null, error_code: "not_connected" });
    expect(integ!.resolution.resolved_connection_ids).toEqual([]);
    // Candidates carry the resolver's serving-auth filter: the `backup` row serves nothing.
    expect(integ!.resolution.candidates).toEqual([]);
  });

  // The agent's own auth_key serving none of its selection is a configuration error, reported
  // as such — not `auth_key_mismatch` against the actor's connection on the serving auth.
  it("agent auth_key serving no selected tool → configuration error (parity)", async () => {
    await seedTwoAuthIntegration({ auth_key: "backup" });
    await db.insert(integrationConnections).values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: "main",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
      scopesGranted: [],
      label: "main",
    });

    const body = (await (await getReadiness()).json()) as ReadinessBody;
    expect(body.blocks_run).toBe(true);
    expect(body.errors.find((e) => e.field === `integrations.${INTEGRATION}`)).toMatchObject({
      code: "auth_key_serves_no_selected_tool",
      required_auth_key: "backup",
    });
    const integ = body.integrations.find((i) => i.integration_package_id === INTEGRATION);
    expect(integ!.run_blocking).toBe(true);
    expect(integ!.resolution).toMatchObject({
      source: null,
      error_code: "auth_key_serves_no_selected_tool",
    });

    const run = await postRun();
    expect(run.status).toBe(409);
    const problem = (await run.json()) as { errors: Array<{ field: string; code: string }> };
    const item = problem.errors.find((e) => e.field === `integrations.${INTEGRATION}`);
    expect(item!.code).toBe("auth_key_serves_no_selected_tool");
  });
});

// #1131 — Google's token endpoint echoes the OIDC scope `email` as
// `https://www.googleapis.com/auth/userinfo.email`. A wildcard agent
// (`tools: "*"`) requires the raw `default_scopes`, so without the catalog
// alias the connection read as missing `email` and every launch 409'd. Uses
// the REAL `@appstrate/gmail-mcp` source manifest, located by name (a version
// bump renames its directory), and the grant Google actually stores.
describe("connection-readiness — Google-echoed `email` scope (#1131)", () => {
  const GMAIL = "@appstrate/gmail-mcp";
  const GMAIL_AGENT = "@rdyorg/gmail-agent";
  const SOURCES_DIR = join(import.meta.dir, "../../../../../scripts/system-packages");
  const GOOGLE_GRANT = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "openid",
  ];

  function loadGmailMcpManifest(): Record<string, unknown> {
    const dirs = readdirSync(SOURCES_DIR).filter((d) =>
      /^integration-gmail-mcp-\d+\.\d+\.\d+$/.test(d),
    );
    if (dirs.length !== 1) throw new Error(`expected one gmail-mcp source, got [${dirs}]`);
    return JSON.parse(readFileSync(join(SOURCES_DIR, dirs[0]!, "manifest.json"), "utf8"));
  }

  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "rdyorg" });
  });

  async function seedWildcardGmailAgent(grant: string[]) {
    const manifest = loadGmailMcpManifest();
    await seedPackage({
      id: GMAIL,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    // Published so the run's version freeze judges the pinned manifest, as in prod.
    await seedPackageVersion({
      packageId: GMAIL,
      version: manifest.version as string,
      manifest,
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, GMAIL);

    await seedAgent({
      id: GMAIL_AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: GMAIL_AGENT,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: "Gmail Wildcard Agent",
        dependencies: { integrations: { [GMAIL]: `^${manifest.version as string}` } },
        integrations_configuration: { [GMAIL]: { tools: "*" } },
      },
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, GMAIL_AGENT);

    await db.insert(integrationConnections).values({
      integrationId: GMAIL,
      authKey: "primary",
      accountId: "user@example.com",
      label: "Connexion 1",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { access_token: "live" } }),
      scopesGranted: grant,
    });
  }

  async function readiness(): Promise<ReadinessBody> {
    const res = await app.request(`/api/agents/${GMAIL_AGENT}/connection-readiness`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as ReadinessBody;
  }

  function launch() {
    return app.request(`/api/agents/${GMAIL_AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  it("the real Google grant satisfies a wildcard agent — readiness clean, launch not 409", async () => {
    await seedWildcardGmailAgent(GOOGLE_GRANT);

    const body = await readiness();
    expect(body.errors).toEqual([]);
    expect(body.blocks_run).toBe(false);

    // The launch clears the connection gate and dies at the NEXT one (no model
    // is seeded) — before any run row exists, so nothing races the truncate.
    const res = await launch();
    expect(res.status).not.toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("model_not_configured");
  });

  it("still blocks when a real non-email scope is missing (discriminating control)", async () => {
    const readonly = "https://www.googleapis.com/auth/gmail.readonly";
    await seedWildcardGmailAgent(GOOGLE_GRANT.filter((s) => s !== readonly));

    const body = await readiness();
    expect(body.blocks_run).toBe(true);
    const err = body.errors.find((e) => e.field === `integrations.${GMAIL}`) as
      { code: string; missing_scopes?: string[] } | undefined;
    expect(err?.code).toBe("insufficient_scopes");
    // Only the genuinely absent scope — `email` must not ride along.
    expect(err?.missing_scopes).toEqual([readonly]);

    expect((await launch()).status).toBe(409);
  });
});
