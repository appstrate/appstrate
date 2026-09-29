// SPDX-License-Identifier: Apache-2.0

/**
 * The launches the SPA builds before `useRunAgent` puts them on the wire.
 *
 * The retry of a launch refused with `409 missing_integration_connection` only
 * touches connection picks (adds the modal's, drops an outranked one); dropping
 * anything else changes the run — or gets it refused, as the input did (#1539).
 * A second 409 retries the first retry, not the original launch. "Lancer avec options…" sends an option
 * only when set, so an untouched modal launches what plain "Lancer" does.
 */

import { describe, it, expect } from "bun:test";
import { launchFromOptions, retryLaunch } from "../run-launch.ts";

describe("retryLaunch", () => {
  it("replays the input typed in the run modal", () => {
    expect(
      retryLaunch(
        { input: { prompt: "bonjour" }, version: "draft" },
        { "@acme/crm": ["conn_1"] },
        [],
      ),
    ).toEqual({
      input: { prompt: "bonjour" },
      version: "draft",
      connectionOverrides: { "@acme/crm": ["conn_1"] },
    });
  });

  it("replays a rerun_from launch without inventing an input", () => {
    expect(retryLaunch({ rerun_from: "run_1", version: "1.0.0" }, {}, [])).toEqual({
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
    expect(retryLaunch(launch, {}, [])).toEqual({ ...launch, connectionOverrides: {} });
  });

  it("merges the picks over the launch's own connection picks", () => {
    expect(
      retryLaunch(
        { connectionOverrides: { "@acme/crm": ["conn_old"], "@acme/mail": ["conn_mail"] } },
        { "@acme/crm": ["conn_new"] },
        [],
      ).connectionOverrides,
    ).toEqual({ "@acme/crm": ["conn_new"], "@acme/mail": ["conn_mail"] });
  });

  it("drops the launch's own pick refused as outranked: the lock leaves nothing to re-pick", () => {
    expect(
      retryLaunch(
        { connectionOverrides: { "@acme/crm": ["conn_outside"], "@acme/mail": ["conn_mail"] } },
        {},
        [{ field: "integrations.@acme/crm", code: "override_outranked", message: "outranked" }],
      ).connectionOverrides,
    ).toEqual({ "@acme/mail": ["conn_mail"] });
  });

  it("a second 409 builds on the first retry: a pick dropped as outranked stays dropped", () => {
    // The launcher keeps each retried launch, so the next retry starts from it.
    const first = retryLaunch(
      { connectionOverrides: { "@acme/crm": ["conn_outside"], "@acme/mail": ["conn_mail"] } },
      {},
      [{ field: "integrations.@acme/crm", code: "override_outranked", message: "outranked" }],
    );
    // The second 409 names another integration, with nothing to pick: crm must not come back.
    expect(
      retryLaunch(first, {}, [
        { field: "integrations.@acme/mail", code: "not_connected", message: "connect" },
      ]).connectionOverrides,
    ).toEqual({ "@acme/mail": ["conn_mail"] });
  });
});

describe("launchFromOptions", () => {
  const untouched = { input: {}, version: "draft", overrides: {}, dependencyOverrides: {} };

  it("sends only the version when nothing was set, like plain Lancer", () => {
    expect(launchFromOptions(untouched)).toEqual({ version: "draft" });
  });

  it("maps every set option onto its launch field", () => {
    expect(
      launchFromOptions({
        input: { prompt: "bonjour" },
        version: "1.0.0",
        overrides: {
          model_id_override: "model_1",
          generation_config_override: { temperature: 0.2 },
          proxy_id_override: "proxy_1",
          connection_overrides: { "@acme/crm": ["conn_1"] },
        },
        dependencyOverrides: { "@acme/skill": "draft" },
      }),
    ).toEqual({
      input: { prompt: "bonjour" },
      version: "1.0.0",
      modelId: "model_1",
      generation: { temperature: 0.2 },
      proxyId: "proxy_1",
      connectionOverrides: { "@acme/crm": ["conn_1"] },
      dependencyOverrides: { "@acme/skill": "draft" },
    });
  });

  it('passes the "none" proxy pick through: it is the wire value for no proxy', () => {
    expect(
      launchFromOptions({ ...untouched, overrides: { proxy_id_override: "none" } }).proxyId,
    ).toBe("none");
  });

  it("leaves out empty overrides instead of sending blanks", () => {
    expect(
      launchFromOptions({
        ...untouched,
        overrides: { model_id_override: "", proxy_id_override: "" },
      }),
    ).toEqual({ version: "draft" });
  });
});
