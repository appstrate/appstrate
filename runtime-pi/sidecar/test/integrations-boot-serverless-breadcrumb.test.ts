// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `pushServerlessReadyBreadcrumb` — the serverless (`sourceKind:
 * "none"`) branch breadcrumb — and for `assertIntegrationExposesTools`, the
 * boot-contract gate that turns the same condition into a run failure.
 *
 * A serverless integration whose config didn't list `"api_call"` exposes zero
 * tools and is non-functional. It must surface as a `warn` with an actionable
 * message rather than the success-toned `api_call ready` breadcrumb, which is
 * indistinguishable in tone from the healthy `(N tools)` case. The breadcrumb
 * is the diagnostic trail only — the run is failed by the assertion, which
 * throws into `bootIntegrations`' per-spec catch (`failed[]` → `report.ok:
 * false` → the agent container aborts). Boot-level coverage of that path lives
 * in `integrations-boot-zero-tools.test.ts`.
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
  } as IntegrationSpawnSpec;
}

describe("pushServerlessReadyBreadcrumb", () => {
  it("warns when 0 tools were exposed", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushServerlessReadyBreadcrumb(serverlessSpec(), 0, 12, breadcrumbs);

    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]!.level).toBe("warn");
    expect(breadcrumbs[0]!.message).toContain("api_call exposed 0 tools");
    expect(breadcrumbs[0]!.message).toContain(
      'integrations_configuration["@tractr/google-drive"].tools',
    );
    expect(breadcrumbs[0]!.data).toMatchObject({
      integrationId: "@tractr/google-drive",
      kind: "serverless",
      durationMs: 12,
      toolCount: 0,
    });
  });

  it("never uses the success-toned 'ready' wording for 0 tools", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushServerlessReadyBreadcrumb(serverlessSpec(), 0, 5, breadcrumbs);

    expect(breadcrumbs[0]!.message).not.toContain("ready");
  });

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
