// SPDX-License-Identifier: Apache-2.0

/**
 * What the enriched-run reads project out of the `runs` table.
 *
 * The three enriched read paths (`listRunsWithFilter`, `listGlobalRuns`,
 * `getRunFull`) select a NAMED column list, not the whole table: the row is
 * wider than the wire DTO, and eight of its columns — `modelCost`,
 * `resolvedIntegrationVersions`, `chatSessionId`, `sinkSecretEncrypted`,
 * `sinkExpiresAt`, `sinkClosedAt`, `lastEventSequence`, `lastHeartbeatAt` — are
 * never read by the mapper. `sinkSecretEncrypted` is an AES-256-GCM credential
 * ciphertext, so not fetching it is defence in depth on top of not emitting it.
 *
 * Narrowing a projection is exactly the change that silently drops a field from
 * an API response, so this pins both directions:
 *  - every DTO field a populated run carries still round-trips, on the LIST and
 *    on the DETAIL read (they use different query builders);
 *  - none of the excluded columns appears in the response under any casing.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";

const app = getTestApp();

/** Columns the projection deliberately does not fetch, in every casing they could surface as. */
const EXCLUDED_KEYS = [
  "modelCost",
  "model_cost",
  "resolvedIntegrationVersions",
  "resolved_integration_versions",
  "chatSessionId",
  "chat_session_id",
  "sinkSecretEncrypted",
  "sink_secret_encrypted",
  "sinkExpiresAt",
  "sink_expires_at",
  "sinkClosedAt",
  "sink_closed_at",
  "lastEventSequence",
  "last_event_sequence",
  "lastHeartbeatAt",
  "last_heartbeat_at",
  // `resolved_connections` IS read — but only through the display-safe
  // `connections_used` projection, which drops the internal connection id.
  "resolvedConnections",
  "resolved_connections",
];

describe("Enriched run projection", () => {
  let ctx: TestContext;
  let runId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    const agent = await seedAgent({ id: `@${ctx.org.slug}/proj-agent`, orgId: ctx.orgId });
    const run = await seedRun({
      packageId: agent.id,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "success",
      runNumber: 7,
      input: { q: "hello" },
      result: { output: { ok: true } },
      checkpoint: { step: 2 },
      metadata: { source: "test" },
      contextSnapshot: { tokens: 10 },
      error: null,
      duration: 1234,
      cost: 0.25,
      costPricingStatus: "priced",
      tokenUsage: { input_tokens: 10, output_tokens: 5 },
      versionLabel: "1.0.0",
      versionRef: "1.0.0",
      proxyLabel: "proxy-a",
      modelLabel: "model-a",
      modelSource: "org",
      runnerName: "runner-a",
      runnerKind: "pi",
      agentScope: "@acme",
      agentName: "proj-agent",
      runOrigin: "platform",
      connectionOverrides: { "@acme/gmail": "conn_1" },
      dependencyOverrides: { "@acme/skill": "draft" },
      // Excluded-by-design columns, all populated so an accidental spread shows.
      modelCost: { input: 1, output: 2 },
      resolvedIntegrationVersions: {
        "@acme/gmail": { version: "9.9.9-internal-only", source: "version" },
      },
      sinkSecretEncrypted: "v1:super-secret-ciphertext",
      sinkExpiresAt: new Date(Date.now() + 3_600_000),
      lastEventSequence: 12,
      resolvedConnections: {
        "@acme/gmail": { connectionId: "conn_1", label: "Work", accountId: "a@b.c", source: "pin" },
      },
    });
    runId = run.id;
  });

  /** Fields whose presence AND value the DTO promises for the run seeded above. */
  function expectDtoRoundTrip(body: Record<string, unknown>) {
    expect(body.id).toBe(runId);
    expect(body.status).toBe("success");
    expect(body.runNumber).toBe(7);
    expect(body.input).toEqual({ q: "hello" });
    expect(body.result).toEqual({ output: { ok: true } });
    expect(body.checkpoint).toEqual({ step: 2 });
    expect(body.metadata).toEqual({ source: "test" });
    expect(body.contextSnapshot).toEqual({ tokens: 10 });
    expect(body.duration).toBe(1234);
    expect(body.cost).toBe(0.25);
    expect(body.cost_pricing_status).toBe("priced");
    expect(body.token_usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(body.version_label).toBe("1.0.0");
    expect(body.version_ref).toBe("1.0.0");
    expect(body.proxy_label).toBe("proxy-a");
    expect(body.model_label).toBe("model-a");
    expect(body.model_source).toBe("org");
    expect(body.runner_name).toBe("runner-a");
    expect(body.runner_kind).toBe("pi");
    expect(body.agent_scope).toBe("@acme");
    expect(body.agent_name).toBe("proj-agent");
    expect(body.runOrigin).toBe("platform");
    expect(body.connection_overrides).toEqual({ "@acme/gmail": "conn_1" });
    expect(body.dependency_overrides).toEqual({ "@acme/skill": "draft" });
    expect(body.started_at).toBeString();
    expect(body.orgId).toBe(ctx.orgId);
    expect(body.applicationId).toBe(ctx.defaultAppId);
    expect(body.userId).toBe(ctx.user.id);
    // Enrichment computed alongside the projection.
    expect(body.file_counts).toEqual({ input: 0, output: 0 });
    expect(body.unread).toBeBoolean();
    // `resolvedConnections` reaches the client only in its display-safe form.
    expect(body.connections_used).toEqual([
      { integration_id: "@acme/gmail", label: "Work", account_id: "a@b.c", source: "pin" },
    ]);
  }

  function expectNoInternalColumns(body: Record<string, unknown>) {
    for (const key of EXCLUDED_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
    // Belt and braces: the ciphertext must not appear anywhere in the payload,
    // whatever key it might have been nested under.
    expect(JSON.stringify(body)).not.toContain("super-secret-ciphertext");
    expect(JSON.stringify(body)).not.toContain("9.9.9-internal-only");
  }

  it("round-trips every DTO field on the detail read", async () => {
    const res = await app.request(`/api/runs/${runId}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expectDtoRoundTrip(body);
    expectNoInternalColumns(body);
  });

  it("round-trips every DTO field on the list read", async () => {
    const res = await app.request("/api/runs", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    const row = body.data.find((r) => r.id === runId);
    expect(row).toBeDefined();
    expectDtoRoundTrip(row!);
    expectNoInternalColumns(row!);
  });
});
