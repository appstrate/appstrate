// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/agents/:scope/:name/run — 412 missing_integration_connection envelope.
 *
 * When an agent declares `dependencies.integrations[X]` but the calling
 * actor has no resolvable connection for X (or the integration is in an
 * unhealthy state), the run is refused upfront with a 412 envelope
 * carrying every integration failure on `errors[]`. This is the CONTRACT
 * the frontend's `MissingConnectionsModal` consumes — its parsing logic
 * keys off `errors[].field.startsWith("integrations.")` to render the
 * "you need to connect X before running this agent" picker.
 *
 * Wire shape (must hold):
 *   { type, title: "Missing Integration Connection",
 *     status: 412, code: "missing_integration_connection",
 *     detail: <first error's message>,
 *     errors: [
 *       { field: "integrations.{packageId}",
 *         code: "not_connected" | "must_choose_connection" | "insufficient_scopes" | …,
 *         title: <human-readable>,
 *         message: <human-readable>,
 *         // optional smuggles:
 *         candidateConnectionIds?: string[],
 *         connection_id?, missing_scopes?, owned_by_actor? }
 *     ] }
 *
 * Code path: agent-readiness.ts:151-158. Triggered by resolveRunPreflight
 * inside the run pipeline.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const AGENT = "@runorg/agent-needing-integ";
const INTEGRATION = "@runorg/svc";
const SECOND_INTEGRATION = "@runorg/extra-svc";
const MCP_SERVER = "@runorg/svc-server";

function buildAgentManifest(integrations: string[]): Record<string, unknown> {
  const deps: Record<string, string> = {};
  const sel: Record<string, { tools?: string[] }> = {};
  for (const id of integrations) {
    deps[id] = "^1.0.0";
    sel[id] = { tools: ["search"] };
  }
  return {
    name: AGENT,
    version: "1.0.0",
    type: "agent",
    schema_version: "2.0",
    display_name: "Connection-Dependent Agent",
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
    tools: { search: {} },
  });
}

interface ValidationFieldError {
  field: string;
  code: string;
  title?: string;
  message: string;
  candidateConnectionIds?: string[];
  connection_id?: string;
  missing_scopes?: string[];
  owned_by_actor?: boolean;
}

interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  errors?: ValidationFieldError[];
}

describe("POST /api/agents/:scope/:name/run — 412 missing_integration_connection", () => {
  let ctx: TestContext;

  async function seedIntegration(id: string) {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(id),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
  }

  async function seedConnection(integrationId: string, userId: string): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationPackageId: integrationId,
        authKey: "primary",
        accountId: `acct-${userId.slice(0, 6)}`,
        applicationId: ctx.defaultAppId,
        userId,
        endUserId: null,
        credentialsEncrypted: encryptCredentials({ api_key: "secret-value" }),
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "runorg" });
  });

  it("returns 412 with the envelope shape when an integration dep has no connection (not_connected)", async () => {
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
    await seedIntegration(INTEGRATION);
    // Deliberately NO connection seeded for the actor.

    const res = await app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(412);
    const body = (await res.json()) as ProblemDetails;

    // Top-level envelope.
    expect(body.status).toBe(412);
    expect(body.code).toBe("missing_integration_connection");
    expect(body.title).toBe("Missing Integration Connection");
    expect(body.detail).toBeTruthy();

    // errors[] is the contract the MissingConnectionsModal consumes.
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors).toHaveLength(1);

    const err = body.errors![0]!;
    // Field path uses the `integrations.` prefix — the modal filters on this.
    expect(err.field).toBe(`integrations.${INTEGRATION}`);
    expect(err.code).toBe("not_connected");
    expect(err.title).toBe("Integration Not Connected");
    expect(err.message).toBeTruthy();
  });

  it("accumulates one errors[] entry per missing integration (modal renders the full list)", async () => {
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION, SECOND_INTEGRATION]),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
    await seedIntegration(INTEGRATION);
    await seedIntegration(SECOND_INTEGRATION);
    // Both integrations declared + installed, no connections.

    const res = await app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(412);
    const body = (await res.json()) as ProblemDetails;
    expect(body.code).toBe("missing_integration_connection");

    // Both integrations should surface — one round-trip carries the full
    // picture so the frontend doesn't have to retry to discover each gap.
    expect(body.errors).toHaveLength(2);
    const fields = new Set(body.errors!.map((e) => e.field));
    expect(fields.has(`integrations.${INTEGRATION}`)).toBe(true);
    expect(fields.has(`integrations.${SECOND_INTEGRATION}`)).toBe(true);
    // All entries follow the same shape — code + title + message present.
    for (const e of body.errors!) {
      expect(e.code).toBe("not_connected");
      expect(e.title).toBeTruthy();
      expect(e.message).toBeTruthy();
    }
  });

  it("emits 412 with must_choose_connection + candidateConnectionIds when actor has >1 candidate", async () => {
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
    await seedIntegration(INTEGRATION);

    // Seed TWO connections for the same actor + integration. No pin / no
    // override exists, so the resolver enters the fallback layer with 2
    // candidates and surfaces must_choose_connection.
    const conn1 = await seedConnection(INTEGRATION, ctx.user.id);
    const conn2 = await seedConnection(INTEGRATION, ctx.user.id);

    const res = await app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(412);
    const body = (await res.json()) as ProblemDetails;
    expect(body.code).toBe("missing_integration_connection");

    const err = body.errors!.find((e) => e.field === `integrations.${INTEGRATION}`);
    expect(err).toBeDefined();
    expect(err!.code).toBe("must_choose_connection");

    // The candidateConnectionIds smuggle is the modal's source of truth for
    // rendering the per-actor picker dropdown.
    expect(err!.candidateConnectionIds).toBeDefined();
    expect(err!.candidateConnectionIds!.sort()).toEqual([conn1, conn2].sort());
  });

  it("happy path: returns NON-412 status when the actor has exactly one accessible connection", async () => {
    // Sanity foil — proves the 412 only fires when there's a real gap.
    // Note: the run may still hit a downstream error (e.g. no model
    // configured) — we assert only that it is NOT the 412 missing-connection
    // envelope, so the contract is bidirectionally exercised.
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
    await seedIntegration(INTEGRATION);
    await seedConnection(INTEGRATION, ctx.user.id);

    const res = await app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // Not the 412 envelope — readiness passed. (Downstream model-config
    // errors may still 400; that's a different code path.)
    if (res.status === 412) {
      const body = (await res.json()) as ProblemDetails;
      expect(body.code).not.toBe("missing_integration_connection");
    }
  });
});
