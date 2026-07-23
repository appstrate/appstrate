// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `pushServerlessReadyBreadcrumb` — the serverless (`sourceKind:
 * "none"`) branch breadcrumb.
 *
 * A credential-only integration may intentionally expose zero tools, while an
 * integration that declares `api_call` but whose agent config omits it is
 * misconfigured. The spawn spec preserves that distinction.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationBootBreadcrumb } from "@appstrate/core/sidecar-types";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { pushServerlessReadyBreadcrumb } from "../integrations-boot.ts";

function serverlessSpec(declaresApiCall = false): IntegrationSpawnSpec {
  return {
    integrationId: "@tractr/google-drive",
    namespace: "google_drive",
    sourceKind: "none",
    manifest: { name: "@tractr/google-drive", version: "1.0.0" },
    ...(declaresApiCall ? { declaresApiCall: true } : {}),
    spawnEnv: {},
  } as IntegrationSpawnSpec;
}

describe("pushServerlessReadyBreadcrumb", () => {
  it("stays quiet when api_call is not declared", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushServerlessReadyBreadcrumb(serverlessSpec(), 0, 12, breadcrumbs);

    expect(breadcrumbs).toHaveLength(0);
  });

  it("warns when a declared api_call was filtered down to 0 tools", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushServerlessReadyBreadcrumb(serverlessSpec(true), 0, 12, breadcrumbs);

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
    pushServerlessReadyBreadcrumb(serverlessSpec(true), 0, 5, breadcrumbs);

    expect(breadcrumbs[0]!.message).not.toContain("ready");
  });

  it("emits an info 'ready' breadcrumb for a single tool (singular)", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushServerlessReadyBreadcrumb(serverlessSpec(true), 1, 8, breadcrumbs);

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
    pushServerlessReadyBreadcrumb(serverlessSpec(true), 2, 3, breadcrumbs);

    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]!.level).toBe("info");
    expect(breadcrumbs[0]!.message).toBe("@tractr/google-drive: api_call ready (3ms, 2 tools)");
  });
});
