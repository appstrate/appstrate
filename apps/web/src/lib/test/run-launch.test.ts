// SPDX-License-Identifier: Apache-2.0

/**
 * The retry of a run launch refused with `409 missing_integration_connection`.
 * The recovery modal only adds connection picks; dropping anything else from
 * the launch changes the run — or gets it refused, as the input did (#1539).
 */

import { describe, it, expect } from "bun:test";
import { retryLaunch } from "../run-launch.ts";

describe("retryLaunch", () => {
  it("replays the input typed in the run modal", () => {
    expect(
      retryLaunch({ input: { prompt: "bonjour" }, version: "draft" }, { "@acme/crm": "conn_1" }),
    ).toEqual({
      input: { prompt: "bonjour" },
      version: "draft",
      connectionOverrides: { "@acme/crm": "conn_1" },
    });
  });

  it("replays a rerun_from launch without inventing an input", () => {
    expect(retryLaunch({ rerun_from: "run_1", version: "1.0.0" }, {})).toEqual({
      rerun_from: "run_1",
      version: "1.0.0",
      connectionOverrides: {},
    });
  });

  it("keeps the launch's run options", () => {
    const launch = {
      version: "draft",
      modelId: "model_1",
      proxyId: "none",
      generation: { temperature: 0.2 },
      dependencyOverrides: { "@acme/skill": "draft" },
    };
    expect(retryLaunch(launch, {})).toEqual({ ...launch, connectionOverrides: {} });
  });

  it("merges the picks over the launch's own connection picks", () => {
    expect(
      retryLaunch(
        { connectionOverrides: { "@acme/crm": "conn_old", "@acme/mail": "conn_mail" } },
        { "@acme/crm": "conn_new" },
      ).connectionOverrides,
    ).toEqual({ "@acme/crm": "conn_new", "@acme/mail": "conn_mail" });
  });
});
