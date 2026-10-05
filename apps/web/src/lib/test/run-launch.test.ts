// SPDX-License-Identifier: Apache-2.0

/**
 * The launches the SPA builds before `useRunAgent` puts them on the wire.
 *
 * The retry of a launch refused with `409 missing_integration_connection` only
 * touches connection picks (adds the modal's, drops one the 409 refuses); dropping
 * anything else changes the run — or gets it refused, as the input did (#1539).
 * A second 409 retries the first retry, not the original launch. "Lancer avec options…" sends an option
 * only when set, so an untouched modal launches what plain "Lancer" does.
 */

import { describe, it, expect } from "bun:test";
import { inheritedEntry, launchFromOptions, retryLaunch } from "../run-launch.ts";

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

  it("drops the launch's own pick the 409 refuses: replayed, it would be refused again", () => {
    expect(
      retryLaunch(
        {
          connectionOverrides: {
            "@acme/crm": ["conn_outside"],
            "@acme/notion": ["conn_gone"],
            "@acme/drive": ["conn_no_tool"],
            "@acme/mail": ["conn_mail"],
          },
        },
        {},
        [
          { field: "integrations.@acme/crm", code: "override_outranked", message: "outranked" },
          {
            field: "integrations.@acme/notion",
            code: "override_connection_unavailable",
            message: "unavailable",
          },
          {
            field: "integrations.@acme/drive",
            code: "auth_serves_no_selected_tool",
            message: "no tool",
            connection_id: "conn_no_tool",
          },
        ],
      ).connectionOverrides,
    ).toEqual({ "@acme/mail": ["conn_mail"] });
  });

  it("keeps the launch's own pick under any other code: the retry never switches account", () => {
    const connectionOverrides = {
      "@acme/crm": ["conn_expired"],
      "@acme/drive": ["conn_drive"],
    };
    expect(
      retryLaunch({ connectionOverrides }, {}, [
        {
          field: "integrations.@acme/crm",
          code: "needs_reconnection",
          message: "reconnect",
          connection_id: "conn_expired",
        },
        {
          // Names the pin's connection, not the launch's pick.
          field: "integrations.@acme/drive",
          code: "auth_serves_no_selected_tool",
          message: "no tool",
          connection_id: "conn_pinned",
        },
      ]).connectionOverrides,
    ).toEqual(connectionOverrides);
  });

  it("a second 409 builds on the first retry: a dropped pick stays dropped", () => {
    // The launcher keeps each retried launch, so the next retry starts from it.
    const first = retryLaunch(
      { connectionOverrides: { "@acme/crm": ["conn_outside"], "@acme/mail": ["conn_mail"] } },
      {},
      [{ field: "integrations.@acme/crm", code: "override_outranked", message: "outranked" }],
    );
    // The second 409 names another integration, with nothing to pick: crm must not come back.
    expect(
      retryLaunch(first, {}, [
        { field: "integrations.@acme/drive", code: "not_connected", message: "connect" },
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

describe("inheritedEntry", () => {
  const m1 = { id: "m1", enabled: true };
  const m2 = { id: "m2", enabled: true };
  const off = { id: "off", enabled: false };
  const usable = (m: { id: string; enabled: boolean }) => m.enabled;

  it("names the agent's own setting ahead of the organization default", () => {
    expect(inheritedEntry([m1, m2], "m2", m1, usable)).toBe(m2);
  });

  it("falls to the organization default with no setting, or one whose entry is gone", () => {
    expect(inheritedEntry([m1, m2], null, m1, usable)).toBe(m1);
    expect(inheritedEntry([m1], "deleted", m1, usable)).toBe(m1);
    expect(inheritedEntry(undefined, "m2", undefined, usable)).toBeUndefined();
  });

  it("falls to the organization default past a setting the server skips", () => {
    expect(inheritedEntry([m1, off], "off", m1, usable)).toBe(m1);
  });
});
