// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `pushServerlessReadyBreadcrumb` — the serverless (`sourceKind:
 * "none"`) branch breadcrumb — and for `assertIntegrationExposesTools`, the
 * boot-contract gate that turns the same condition into a run failure.
 *
 * A serverless integration whose config didn't list `"api_call"` exposes zero
 * tools and is non-functional. `bootIntegrations` runs the assertion BEFORE
 * the breadcrumb, so that case never reaches this helper: it throws into the
 * per-spec catch (`failed[]` → `report.ok: false` → the agent container
 * aborts), which emits the single `error` breadcrumb carrying the actionable
 * sentence. Boot-level coverage of that path lives in
 * `integrations-boot-zero-tools.test.ts`; what is left here is the success
 * wording and the gate's own contract.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationBootBreadcrumb } from "@appstrate/core/sidecar-types";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import {
  assertIntegrationExposesTools,
  pushServerlessReadyBreadcrumb,
} from "../integrations-boot.ts";

function serverlessSpec(): IntegrationSpawnSpec {
  return {
    integrationId: "@tractr/google-drive",
    namespace: "google_drive",
    sourceKind: "none",
    manifest: { name: "@tractr/google-drive", version: "1.0.0" },
    spawnEnv: {},
    // An explicit (empty) allowlist, as the spawn resolver emits for every
    // non-wildcard selection — it OMITS the field only for AFPS §4.4
    // `tools: "*"`, which is a different diagnosis (see
    // `integrations-boot-zero-tools.test.ts`). Set explicitly so the fixture
    // does not accidentally read as a wildcard spec.
    toolAllowlist: [],
  } as IntegrationSpawnSpec;
}

describe("pushServerlessReadyBreadcrumb", () => {
  // No zero-tool case here by design: the gate runs first, so this helper is
  // only ever reached with `toolCount > 0`. The zero path is a run FAILURE and
  // is covered against `bootIntegrations` in
  // `integrations-boot-zero-tools.test.ts` — asserting it here again would pin
  // a branch the boot path can no longer take.
  it("emits an info 'ready' breadcrumb for a single tool (singular)", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushServerlessReadyBreadcrumb(serverlessSpec(), 1, 8, breadcrumbs);

    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]!.level).toBe("info");
    expect(breadcrumbs[0]!.message).toBe("@tractr/google-drive: api_call ready (8ms, 1 tool)");
    expect(breadcrumbs[0]!.data).toMatchObject({
      integrationId: "@tractr/google-drive",
      kind: "serverless",
      durationMs: 8,
      toolCount: 1,
    });
  });

  it("emits an info 'ready' breadcrumb for multiple tools (plural)", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushServerlessReadyBreadcrumb(serverlessSpec(), 2, 3, breadcrumbs);

    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]!.level).toBe("info");
    expect(breadcrumbs[0]!.message).toBe("@tractr/google-drive: api_call ready (3ms, 2 tools)");
  });
});

function localSpec(): IntegrationSpawnSpec {
  return {
    integrationId: "@tractr/github",
    namespace: "github",
    sourceKind: "local",
    manifest: {
      name: "@tractr/github",
      version: "1.0.0",
      server: { type: "node", entry_point: "./server.js", packageId: "@tractr/github-server" },
    },
    spawnEnv: {},
  } as IntegrationSpawnSpec;
}

describe("assertIntegrationExposesTools", () => {
  it("throws for a serverless integration with 0 tools, naming the manifest key", () => {
    expect(() => assertIntegrationExposesTools(serverlessSpec(), 0)).toThrow(
      'integrations_configuration["@tractr/google-drive"].tools',
    );
    expect(() => assertIntegrationExposesTools(serverlessSpec(), 0)).toThrow("api_call");
  });

  it("throws for a spawned (local) integration with 0 tools, naming the manifest key", () => {
    expect(() => assertIntegrationExposesTools(localSpec(), 0)).toThrow(
      'integrations_configuration["@tractr/github"].tools',
    );
    expect(() => assertIntegrationExposesTools(localSpec(), 0)).toThrow("nothing callable");
  });

  it("does not throw when at least one tool was registered", () => {
    expect(() => assertIntegrationExposesTools(serverlessSpec(), 1)).not.toThrow();
    expect(() => assertIntegrationExposesTools(localSpec(), 3)).not.toThrow();
  });
});
