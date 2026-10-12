// SPDX-License-Identifier: Apache-2.0

// `connectionRefusalLines`: a 409 `missing_integration_connection` as the lines both
// `--remote` and `--report` print, a choice's candidates under it.

import { describe, it, expect } from "bun:test";
import {
  announceLaunch,
  connectionRefusalLines,
  parseLaunchItems,
} from "../src/commands/run/launch-warnings.ts";

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

  it("drops a candidate outside the contract's shape and keeps its item", () => {
    const kept = { field: "integrations.@appstrate/gmail", code: "not_connected" };
    expect(connectionRefusalLines(refusal([choice([{ label: "No id" }]), kept]))).toEqual([
      "@appstrate/clickup: Integration '@appstrate/clickup' has 2 usable connections; choose one (must_choose_connection)",
      "@appstrate/gmail: not_connected (not_connected)",
    ]);
  });

  it("prints an item with its valid candidate when another candidate is malformed", () => {
    expect(connectionRefusalLines(refusal([choice([candidate({}), { label: "No id" }])]))).toEqual([
      "@appstrate/clickup: Integration '@appstrate/clickup' has 2 usable connections; choose one (must_choose_connection)",
      `  Work (work@acme.com, yours): --connection @appstrate/clickup=${WORK}`,
    ]);
  });

  it("prints a warning's candidates under its item, as a refusal does", () => {
    const out = { stderr: "" };
    announceLaunch({
      type: "appstrate.report.started",
      bundleLabel: "@scope/agent@1.0.0",
      instance: "https://app.example.com",
      run: {
        runId: "run_test_1",
        warnings: parseLaunchItems([
          choice([
            candidate({}),
            candidate({ id: OPS, label: "Ops", account_id: "ops@acme.com", owned_by_actor: false }),
          ]),
        ]),
      },
      writeStdout: () => {},
      writeStderr: (chunk) => (out.stderr += chunk),
    });
    expect(out.stderr).toBe(
      "→ running @scope/agent@1.0.0 (reporting to https://app.example.com as run_test_1)\n" +
        "⚠ @appstrate/clickup: Integration '@appstrate/clickup' has 2 usable connections; choose one (must_choose_connection)\n" +
        `  Work (work@acme.com, yours): --connection @appstrate/clickup=${WORK}\n` +
        `  Ops (ops@acme.com, shared): --connection @appstrate/clickup=${OPS}\n`,
    );
  });

  it("answers null for a body that is not this refusal", () => {
    expect(connectionRefusalLines({ code: "invalid_request", errors: [] })).toBeNull();
  });
});
