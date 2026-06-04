// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the no-silent-degradation guard `pushUnavailableToolBreadcrumb`.
 *
 * When an agent selects N tools from an integration but fewer survive
 * registration (server didn't advertise one under the declared name, or the
 * poisoning sanitiser dropped a too-large descriptor), the shortfall must
 * surface as a `warn` breadcrumb rather than the LLM silently behaving as if
 * the tool was never authorised.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationBootBreadcrumb } from "@appstrate/core/sidecar-types";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { pushUnavailableToolBreadcrumb } from "../integrations-boot.ts";

function specWith(toolAllowlist: string[] | undefined): IntegrationSpawnSpec {
  return {
    integrationId: "@scope/gh",
    namespace: "gh",
    sourceKind: "local",
    manifest: { name: "@scope/gh", version: "1.0.0" },
    spawnEnv: {},
    ...(toolAllowlist !== undefined ? { toolAllowlist } : {}),
  } as IntegrationSpawnSpec;
}

describe("pushUnavailableToolBreadcrumb", () => {
  it("warns when fewer tools survived than the agent selected", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(
      specWith(["list_issues", "create_issue", "close_issue"]),
      2,
      breadcrumbs,
    );
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]!.level).toBe("warn");
    expect(breadcrumbs[0]!.message).toBe("@scope/gh: 1/3 selected tool(s) unavailable");
    expect(breadcrumbs[0]!.data).toMatchObject({
      integrationId: "@scope/gh",
      requested: 3,
      surviving: 2,
      missing: 1,
    });
  });

  it("is silent when every selected tool survived", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(specWith(["list_issues", "create_issue"]), 2, breadcrumbs);
    expect(breadcrumbs).toHaveLength(0);
  });

  it("is silent when more tools survived than selected (count never goes negative)", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(specWith(["list_issues"]), 3, breadcrumbs);
    expect(breadcrumbs).toHaveLength(0);
  });

  it("is silent when the agent selected no tools (empty allowlist)", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(specWith([]), 0, breadcrumbs);
    expect(breadcrumbs).toHaveLength(0);
  });

  it("is silent when no allowlist was declared (legacy all-tools-allowed)", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(specWith(undefined), 0, breadcrumbs);
    expect(breadcrumbs).toHaveLength(0);
  });
});
