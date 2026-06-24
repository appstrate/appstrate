// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the launch-readiness predicates — the centralized logic that
 * keeps the run button's orange badge iso with the agent Connexions tab and the
 * run-kickoff 412 (MissingConnectionsModal). `resolutionBlocksRun` consumes the
 * SAME `IntegrationAgentResolution` the server emits, so this is where the
 * status → blocks-run mapping is pinned.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationAgentResolution } from "@appstrate/shared-types";
import { resolutionBlocksRun } from "../integration-run-readiness";

function resolution(over: Partial<IntegrationAgentResolution>): IntegrationAgentResolution {
  return {
    status: "auto",
    resolved_connection_id: "conn_1",
    resolved_missing_scopes: [],
    resolved_owned_by_actor: true,
    admin_pinned_connection_id: null,
    member_pinned_connection_id: null,
    org_default_connection_id: null,
    org_default_enforced: false,
    can_add_connection: true,
    candidates: [],
    ...over,
  };
}

describe("resolutionBlocksRun", () => {
  it("does not block when a connection auto-resolves fully scoped", () => {
    expect(resolutionBlocksRun(resolution({ status: "auto" }))).toBe(false);
    expect(resolutionBlocksRun(resolution({ status: "pinned" }))).toBe(false);
    expect(resolutionBlocksRun(resolution({ status: "admin_locked" }))).toBe(false);
  });

  it("blocks on missing scopes even when a connection resolves (insufficient_scopes)", () => {
    expect(
      resolutionBlocksRun(resolution({ status: "auto", resolved_missing_scopes: ["write"] })),
    ).toBe(true);
  });

  it("blocks on every unresolved status", () => {
    for (const status of ["none", "must_choose", "needs_reconnection", "stale"] as const) {
      expect(resolutionBlocksRun(resolution({ status, resolved_connection_id: null }))).toBe(true);
    }
  });
});
