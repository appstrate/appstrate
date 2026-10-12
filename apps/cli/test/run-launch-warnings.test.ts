// SPDX-License-Identifier: Apache-2.0

// `connectionRefusalLines`: a 409 `missing_integration_connection` as the lines both
// `--remote` and `--report` print, a choice's candidates under it. `announceLaunch`: the
// preamble, and what a run with no registered run is told about its credential-proxy calls.

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

  it("prints an item with its valid candidate when another candidate is malformed", () => {
    const kept = { field: "integrations.@appstrate/gmail", code: "not_connected" };
    const noCandidate = {
      ...choice([{ label: "No id" }]),
      field: "integrations.@appstrate/notion",
      message: "Integration '@appstrate/notion' has 2 usable connections; choose one",
    };
    expect(
      connectionRefusalLines(
        refusal([choice([candidate({}), { label: "No id" }]), noCandidate, kept]),
      ),
    ).toEqual([
      "@appstrate/clickup: Integration '@appstrate/clickup' has 2 usable connections; choose one (must_choose_connection)",
      `  Work (work@acme.com, yours): --connection @appstrate/clickup=${WORK}`,
      "@appstrate/notion: Integration '@appstrate/notion' has 2 usable connections; choose one (must_choose_connection)",
      "@appstrate/gmail: not_connected (not_connected)",
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

// A locally executed run whose integration tools call the instance's credential proxy
// (`--integrations remote`) names its run with `X-Run-Id` only when one is registered.
// Without one (`--report=false`, or a registration `--report-fallback console` degrades)
// every call is made outside a run.
describe("announceLaunch — credential-proxy calls outside a run", () => {
  const INSTANCE = "https://app.example.com";
  const OUTSIDE_RUN =
    `⚠ no run registered on ${INSTANCE}: integration calls reach its credential proxy outside a run\n` +
    "  they need the credential-proxy:direct permission and reach your own connections only (list: appstrate api GET /api/credential-proxy/connections)\n" +
    "  with --report they go through the registered run instead (credential-proxy:call, the connections the run binds)\n";

  function announce(over: Partial<Parameters<typeof announceLaunch>[0]>) {
    const out = { stdout: "", stderr: "" };
    announceLaunch({
      type: "appstrate.report.started",
      bundleLabel: "@scope/agent@1.0.0",
      instance: INSTANCE,
      run: null,
      writeStdout: (chunk) => (out.stdout += chunk),
      writeStderr: (chunk) => (out.stderr += chunk),
      ...over,
    });
    return out;
  }

  it("says once, under the preamble, what the calls require and reach", () => {
    expect(announce({ proxyTools: 2 })).toEqual({
      stdout: "",
      stderr: `→ running @scope/agent@1.0.0\n${OUTSIDE_RUN}`,
    });
  });

  it("says nothing when the run is registered: its calls carry X-Run-Id", () => {
    const out = announce({ proxyTools: 2, run: { runId: "run_test_1", warnings: [] } });
    expect(out.stderr).toBe(
      `→ running @scope/agent@1.0.0 (reporting to ${INSTANCE} as run_test_1)\n`,
    );
  });

  it("says nothing when no tool calls the proxy (--integrations local or none, or no integration)", () => {
    expect(announce({ proxyTools: 0 }).stderr).toBe("→ running @scope/agent@1.0.0\n");
    expect(announce({}).stderr).toBe("→ running @scope/agent@1.0.0\n");
  });

  it("writes nothing under --json, on either stream", () => {
    expect(announce({ proxyTools: 2, json: true })).toEqual({ stdout: "", stderr: "" });
  });
});
