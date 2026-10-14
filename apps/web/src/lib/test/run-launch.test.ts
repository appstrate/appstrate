// SPDX-License-Identifier: Apache-2.0

/**
 * The launches the SPA builds before `useRunAgent` puts them on the wire.
 *
 * The replay of a launch refused with `409 missing_integration_connection` only
 * drops the launch's own connection pick for the integrations the 409 refused:
 * dropping anything else changes the run, or gets it refused (an agent with a
 * required input refuses a replay without it). "Lancer avec options…" sends an
 * option only when set, so an untouched modal launches what plain "Lancer" does.
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import {
  inheritedEntry,
  launchFromOptions,
  launchRefusal,
  launchFlight,
  retryLaunch,
} from "../run-launch.ts";

describe("launchFlight", () => {
  /** A launch whose request the test settles by hand. */
  function pendingLaunch() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    let started = 0;
    const start = () => {
      started += 1;
      return promise;
    };
    return { start, resolve, reject, started: () => started };
  }
  const settled = () => new Promise((r) => setTimeout(r, 0));
  /** A flight and the pending flag it reports, as the launcher shows it. */
  function flightWithBusy() {
    const busy: boolean[] = [];
    return { flight: launchFlight((b) => busy.push(b)), busy };
  }

  it("sends one request for a double click", async () => {
    const { flight } = flightWithBusy();
    const first = pendingLaunch();
    const second = pendingLaunch();
    // Both clicks land before React re-renders with `isPending`.
    flight.run(first.start, {});
    flight.run(second.start, {});
    expect([first.started(), second.started()]).toEqual([1, 0]);
    first.resolve();
    await settled();
  });

  it("frees the slot when the launch succeeds, and when it fails", async () => {
    const { flight, busy } = flightWithBusy();
    const ok = pendingLaunch();
    const seen: string[] = [];
    flight.run(ok.start, { onSuccess: () => seen.push("ok") });
    ok.resolve();
    await settled();

    const refused = pendingLaunch();
    flight.run(refused.start, { onError: (e) => seen.push(e.message) });
    expect(refused.started()).toBe(1);
    refused.reject(new Error("409"));
    await settled();

    expect(seen).toEqual(["ok", "409"]);
    expect(busy).toEqual([true, false, true, false]);
    const next = pendingLaunch();
    flight.run(next.start, {});
    expect(next.started()).toBe(1);
  });

  it("a launch dismissed while in flight keeps the slot, reports nothing, then frees it", async () => {
    const { flight, busy } = flightWithBusy();
    const retry = pendingLaunch();
    const seen: string[] = [];
    flight.run(retry.start, { onError: (e) => seen.push(e.message) });
    flight.forget();

    // Still being created server-side: a click now would be a second run.
    const tooEarly = pendingLaunch();
    flight.run(tooEarly.start, {});
    expect(tooEarly.started()).toBe(0);
    expect(busy).toEqual([true]);

    retry.reject(new Error("409"));
    await settled();
    expect(seen).toEqual([]);
    expect(busy).toEqual([true, false]);
    const next = pendingLaunch();
    flight.run(next.start, {});
    expect(next.started()).toBe(1);
  });
});

describe("launchRefusal", () => {
  const ITEM = {
    field: "integrations.@acme/crm",
    code: "not_connected",
    message: "connect",
  } as const;
  const refusal = (extensions?: Record<string, unknown>) =>
    new ApiError("missing_integration_connection", "refused", 409, [ITEM], extensions);

  it("reads the version the 409 judged, so recovery reads that version's readiness", () => {
    expect(launchRefusal(refusal({ version_ref: "1.2.0" }))).toEqual({
      errors: [ITEM],
      version: "1.2.0",
    });
    expect(launchRefusal(refusal({ version_ref: "draft" }))?.version).toBe("draft");
  });

  it("names no version the server did not", () => {
    expect(launchRefusal(refusal())).toEqual({ errors: [ITEM], version: undefined });
  });

  it("is null for any other failure", () => {
    expect(launchRefusal(new ApiError("not_found", "gone", 404))).toBeNull();
    expect(launchRefusal(new Error("network"))).toBeNull();
  });
});

describe("retryLaunch", () => {
  it("replays the input typed in the run modal", () => {
    expect(
      retryLaunch(
        {
          input: { prompt: "bonjour" },
          version: "draft",
          connectionOverrides: { "@acme/crm": ["conn_1"] },
        },
        [],
      ),
    ).toEqual({
      input: { prompt: "bonjour" },
      version: "draft",
      connectionOverrides: { "@acme/crm": ["conn_1"] },
    });
  });

  it("replays a rerun_from launch without inventing an input", () => {
    expect(retryLaunch({ rerun_from: "run_1", version: "1.0.0" }, [])).toEqual({
      rerun_from: "run_1",
      version: "1.0.0",
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
    expect(retryLaunch(launch, [])).toEqual(launch);
  });

  it("drops the launch's own pick of each refused integration, whatever the code", () => {
    const codes = [
      "override_outranked",
      "override_connection_unavailable",
      "auth_serves_no_selected_tool",
      "needs_reconnection",
      "insufficient_scopes",
      "must_choose_connection",
      "required_integration_unbound",
    ] as const;
    const launch = { input: { prompt: "bonjour" }, connectionOverrides: { "@acme/crm": ["c1"] } };
    for (const code of codes) {
      expect(
        retryLaunch(launch, [
          { field: "integrations.@acme/crm", code, message: code, connection_id: "c1" },
        ]),
      ).toEqual({ input: { prompt: "bonjour" } });
    }
  });

  it("keeps the own pick of an integration the 409 does not name", () => {
    expect(
      retryLaunch(
        { connectionOverrides: { "@acme/crm": ["conn_expired"], "@acme/mail": ["conn_mail"] } },
        [{ field: "integrations.@acme/crm", code: "needs_reconnection", message: "reconnect" }],
      ),
    ).toEqual({ connectionOverrides: { "@acme/mail": ["conn_mail"] } });
  });

  it("replays a launch without picks unchanged", () => {
    const launch = { input: { prompt: "bonjour" }, version: "draft" };
    expect(
      retryLaunch(launch, [
        { field: "integrations.@acme/crm", code: "not_connected", message: "connect" },
      ]),
    ).toEqual(launch);
  });
});

describe("launchFromOptions", () => {
  const untouched = {
    input: {},
    version: "draft",
    overrides: {},
    declaredIntegrations: ["@acme/crm"],
    dependencyOverrides: {},
  };

  it("sends only the version when nothing was set, like plain Lancer", () => {
    expect(launchFromOptions(untouched)).toEqual({ version: "draft" });
  });

  it("sends an override of 'no connection' as an empty set", () => {
    expect(
      launchFromOptions({ ...untouched, overrides: { connection_overrides: { "@acme/crm": [] } } }),
    ).toEqual({ version: "draft", connectionOverrides: { "@acme/crm": [] } });
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
        declaredIntegrations: ["@acme/crm"],
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

  it("drops a pick for an integration the launched version does not declare", () => {
    const picks = { "@acme/crm": ["conn_1"], "@acme/retired": ["conn_9"] };
    expect(
      launchFromOptions({ ...untouched, overrides: { connection_overrides: picks } })
        .connectionOverrides,
    ).toEqual({ "@acme/crm": ["conn_1"] });
  });

  it("keeps every pick while the version's integrations have not loaded", () => {
    const picks = { "@acme/crm": ["conn_1"], "@acme/drive": ["conn_2"] };
    expect(
      launchFromOptions({
        ...untouched,
        overrides: { connection_overrides: picks },
        declaredIntegrations: undefined,
      }).connectionOverrides,
    ).toEqual(picks);
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
