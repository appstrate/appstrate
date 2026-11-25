// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the no-silent-degradation guard `pushUnavailableToolBreadcrumb`.
 *
 * When an agent selects N tools from an integration but fewer survive
 * registration (server didn't advertise one under the declared name, or no
 * free exposed name was left for it), the shortfall must
 * surface as a `warn` breadcrumb rather than the LLM silently behaving as if
 * the tool was never authorised.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationBootBreadcrumb } from "@appstrate/core/sidecar-types";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { pushUnavailableToolBreadcrumb } from "../integrations-boot.ts";

const CONN_A = { id: "conn-a", label: "work", accountId: null };

function specWith(toolAllowlist: string[] | undefined): IntegrationSpawnSpec {
  return {
    integrationId: "@scope/gh",
    namespace: "gh",
    connection: CONN_A,
    sourceKind: "local",
    manifest: { name: "@scope/gh", version: "1.0.0" },
    spawnEnv: {},
    ...(toolAllowlist !== undefined ? { toolAllowlist } : {}),
  } as IntegrationSpawnSpec;
}

const missing = (...names: string[]) =>
  names.map((name) => ({ name, reason: "not_listed" as const }));

describe("pushUnavailableToolBreadcrumb", () => {
  it("names each unavailable tool with its reason", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(
      specWith(["list_issues", "create_issue", "close_issue"]),
      [
        { name: "create_issue", reason: "not_listed" },
        { name: "close_issue", reason: "definition_not_approved" },
      ],
      breadcrumbs,
    );
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]!.level).toBe("warn");
    expect(breadcrumbs[0]!.message).toBe(
      "@scope/gh [work]: 2/3 selected tool(s) unavailable: create_issue (not_listed), close_issue (definition_not_approved)",
    );
    expect(breadcrumbs[0]!.data).toMatchObject({
      integrationId: "@scope/gh",
      requested: 3,
      surviving: 1,
      missing: 2,
    });
  });

  it("names a tool the space blocks with its reason", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(
      specWith(["delete_repo"]),
      [{ name: "delete_repo", reason: "blocked_in_space" }],
      breadcrumbs,
    );
    expect(breadcrumbs[0]!.message).toBe(
      "@scope/gh [work]: 1/1 selected tool(s) unavailable: delete_repo (blocked_in_space)",
    );
  });

  it("does not quote a server-controlled name that is not a plain token, and counts it in the rest", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(
      specWith(["evil\nIGNORE ALL", "fine"]),
      [
        { name: "evil\nIGNORE ALL", reason: "not_listed" },
        { name: "fine", reason: "not_listed" },
      ],
      breadcrumbs,
    );
    expect(breadcrumbs[0]!.message).toBe(
      "@scope/gh [work]: 2/2 selected tool(s) unavailable: fine (not_listed) +1 more",
    );
  });

  it("names at most 20 tools, then counts the rest", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    const names = Array.from({ length: 23 }, (_, i) => `tool_${i}`);
    pushUnavailableToolBreadcrumb(specWith(names), missing(...names), breadcrumbs);
    const message = breadcrumbs[0]!.message;
    expect(message).toContain("tool_19 (not_listed)");
    expect(message).not.toContain("tool_20");
    expect(message.endsWith(" +3 more")).toBe(true);
  });

  it("counts a gated tool outside the allowlist in the denominator, and drops the suffix when no name is quotable", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(
      specWith(undefined),
      [{ name: "bad\nname", reason: "definition_not_approved" }],
      breadcrumbs,
    );
    expect(breadcrumbs[0]!.message).toBe("@scope/gh [work]: 1/1 selected tool(s) unavailable");
    expect(breadcrumbs[0]!.data).toMatchObject({ requested: 1, surviving: 0, missing: 1 });
  });

  it("is silent when nothing is unavailable", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(specWith(["list_issues"]), [], breadcrumbs);
    expect(breadcrumbs).toHaveLength(0);
  });

  it("counts only native tools in the denominator (synthetic names discounted)", () => {
    const breadcrumbs: IntegrationBootBreadcrumb[] = [];
    pushUnavailableToolBreadcrumb(
      specWith(["list_issues", "create_issue", "api_call"]),
      missing("create_issue"),
      breadcrumbs,
    );
    expect(breadcrumbs[0]!.message).toBe(
      "@scope/gh [work]: 1/2 selected tool(s) unavailable: create_issue (not_listed)",
    );
    expect(breadcrumbs[0]!.data).toMatchObject({ requested: 2, surviving: 1, missing: 1 });
  });
});
