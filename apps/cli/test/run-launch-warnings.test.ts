// SPDX-License-Identifier: Apache-2.0

// `connectionRefusalLines`: a 409 `missing_integration_connection` as the lines both
// `--remote` and `--report` print, a choice's candidates under it.

import { describe, it, expect } from "bun:test";
import { connectionRefusalLines } from "../src/commands/run/launch-warnings.ts";

const WORK = "11111111-1111-4111-8111-111111111111";
const OPS = "22222222-2222-4222-8222-222222222222";

const candidate = (over: Record<string, unknown>) => ({
  id: WORK,
  label: "Work",
  account_id: "work@acme.com",
  owned_by_actor: true,
  needs_reconnection: false,
  scopes_granted: [],
  missing_scopes: [],
  ...over,
});

const choice = (candidates: unknown[]) => ({
  field: "integrations.@appstrate/clickup",
  code: "must_choose_connection",
  message: "Integration '@appstrate/clickup' has 2 usable connections; choose one",
  candidate_connections: candidates,
});

const refusal = (errors: unknown[]) => ({ code: "missing_integration_connection", errors });

describe("connectionRefusalLines", () => {
  it("lists a choice's candidates under it: label, account, owner, state, and the flag", () => {
    const shared = candidate({
      id: OPS,
      label: "Ops",
      account_id: "ops@acme.com",
      owned_by_actor: false,
      needs_reconnection: true,
    });
    expect(connectionRefusalLines(refusal([choice([candidate({}), shared])]))).toEqual([
      "@appstrate/clickup: Integration '@appstrate/clickup' has 2 usable connections; choose one (must_choose_connection)",
      `  Work (work@acme.com, yours): --connection @appstrate/clickup=${WORK}`,
      `  Ops (ops@acme.com, shared, needs reconnection): --connection @appstrate/clickup=${OPS}`,
    ]);
  });

  it("drops an item whose candidates are not the contract's shape, like any malformed item", () => {
    const kept = { field: "integrations.@appstrate/gmail", code: "not_connected" };
    expect(connectionRefusalLines(refusal([choice([{ label: "No id" }]), kept]))).toEqual([
      "@appstrate/gmail: not_connected (not_connected)",
    ]);
  });

  it("answers null for a body that is not this refusal", () => {
    expect(connectionRefusalLines({ code: "invalid_request", errors: [] })).toBeNull();
  });
});
