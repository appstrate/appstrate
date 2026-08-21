// SPDX-License-Identifier: Apache-2.0

/**
 * Fixtures for run tests that exercise the integration-connection readiness
 * gate — the `412 must_choose_connection` / `connection_overrides` contract.
 *
 * Reproducing that gate takes a specific, non-obvious arrangement: an
 * integration package WITH a published version (the dependency freeze resolves
 * the agent's semver pin against it), two connections on the same auth for the
 * SAME actor (two candidates is what makes the resolver ambiguous), a default
 * org model (without one the launch dies before run creation), and an
 * orchestrator that does not need Docker.
 *
 * The same arrangement is needed on both sides of the seam the remedy travels:
 * the REST route (`POST /api/runs/inline`) and the MCP `run_and_wait` tool that
 * dispatches into it. Keeping ONE copy is what stops the two suites from
 * drifting into testing subtly different worlds.
 */

import { db } from "./db.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { seedPackage, seedPackageVersion } from "./seed.ts";
import { localIntegrationManifest, httpHeaderDelivery } from "./integration-manifests.ts";
import type { TestContext } from "./auth.ts";
import { installPackage } from "../../src/services/application-packages.ts";
import { createApiKeyCredential } from "../../src/services/model-providers/credentials.ts";
import { createOrgModel, setDefaultModel } from "../../src/services/org-models.ts";
import { waitForInFlight } from "../../src/services/run-tracker.ts";
import {
  type RunOrchestrator,
  type WorkloadHandle,
  type WorkloadSpec,
  type IsolationBoundary,
  type CleanupReport,
  type StopResult,
} from "../../src/services/orchestrator/index.ts";

/**
 * Minimal no-op orchestrator: workloads "run" instantly and exit 0.
 *
 * Not connection-specific — it is here because this is the only shared home the
 * three suites that need an inert orchestrator have (`runs.test.ts`, the inline
 * 412 suite, the MCP `run_and_wait` suite). Every other fake in the tree records
 * or configures something and is genuinely its own; this one was a verbatim
 * duplicate, which is exactly what silently drifts.
 */
export function createFakeOrchestrator(): RunOrchestrator {
  const handle = (runId: string, role: string): WorkloadHandle => ({
    id: `${role}_${runId}`,
    runId,
    role,
  });
  return {
    async initialize() {},
    async shutdown() {},
    async cleanupOrphans(): Promise<CleanupReport> {
      return { workloads: 0, isolationBoundaries: 0, workspaces: 0 };
    },
    async ensureImages() {},
    async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
      return {
        id: `net_${runId}`,
        name: `appstrate-exec-${runId}`,
        workspace: { kind: "directory", path: `/tmp/test-ws-${runId}` },
        sidecarEndpoints: {
          sidecarUrl: "http://sidecar:8080",
          llmProxyUrl: "http://sidecar:8080/llm",
          forwardProxyUrl: "http://sidecar:8081",
          noProxy: "sidecar,localhost,127.0.0.1",
        },
      };
    },
    async removeIsolationBoundary() {},
    async createSidecar(runId: string): Promise<WorkloadHandle> {
      return handle(runId, "sidecar");
    },
    async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
      return handle(spec.runId, spec.role);
    },
    async startWorkload() {},
    async stopWorkload() {},
    async removeWorkload() {},
    async waitForExit(): Promise<number> {
      return 0;
    },
    async *streamLogs(): AsyncGenerator<string> {},
    async stopByRunId(): Promise<StopResult> {
      return "stopped";
    },
    async resolvePlatformApiUrl(): Promise<string> {
      return "http://platform:3000";
    },
  };
}

/** Inline agent manifest declaring one integration dependency per id. */
export function inlineAgentManifest(integrations: string[] = []): Record<string, unknown> {
  const deps: Record<string, string> = {};
  const config: Record<string, { tools: string[] }> = {};
  for (const id of integrations) {
    deps[id] = "^1.0.0";
    config[id] = { tools: ["search"] };
  }
  return {
    name: "@inline/ignored", // overridden by the platform
    display_name: "Inline Connection Agent",
    version: "0.0.0",
    type: "agent",
    schema_version: "0.2",
    dependencies: { integrations: deps },
    integrations_configuration: config,
  };
}

/** AFPS integration manifest with a single api_key auth exposing a `search` tool. */
function connectionTestIntegrationManifest(id: string) {
  return localIntegrationManifest({
    name: id,
    serverName: `${id}-server`,
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
 * Seed the integration package + a PUBLISHED 1.0.0 version + install it in the
 * context's default application. The published version is what the run's
 * dependency freeze resolves the agent's `^1.0.0` pin against — without it
 * kickoff aborts with 422 `dependency_unresolved` long before the connection
 * snapshot.
 */
export async function seedConnectionTestIntegration(ctx: TestContext, id: string): Promise<void> {
  await seedPackage({
    id,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: connectionTestIntegrationManifest(id),
  });
  await seedPackageVersion({
    packageId: id,
    version: "1.0.0",
    manifest: connectionTestIntegrationManifest(id) as unknown as Record<string, unknown>,
  });
  await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
}

/** Add one connection on the integration's `primary` auth, owned by the ctx user. */
export async function seedIntegrationConnection(
  ctx: TestContext,
  integrationId: string,
): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId,
      authKey: "primary",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret-value" } }),
      scopesGranted: [],
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

/** The org needs a resolvable default model for a launch to reach run creation. */
export async function seedDefaultOrgModel(ctx: TestContext): Promise<void> {
  const credentialId = await createApiKeyCredential({
    orgId: ctx.orgId,
    userId: ctx.user.id,
    label: "Connection fixture credential",
    providerId: "openai",
    apiKey: "sk-test-not-a-real-key",
  });
  const modelDbId = await createOrgModel(
    ctx.orgId,
    "Connection Fixture GPT",
    "gpt-5.5",
    ctx.user.id,
    credentialId,
  );
  await setDefaultModel(ctx.orgId, modelDbId);
}

/**
 * The trigger is fire-and-forget: the fake orchestrator exits 0 immediately and
 * the platform synthesises a terminal. Drain the in-flight tracker (plus a beat
 * for the post-untrack async tail) so the background DB writes stay inside the
 * CURRENT test instead of racing the next `truncateAll()`.
 */
export async function waitForRunPipelineSettled(): Promise<void> {
  await waitForInFlight(10_000);
  await Bun.sleep(300);
}
