// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `describeResolution` — the one reading of the server verdict
 * (`source` + `error_code`, the resolver's vocabulary) the picker, the 409
 * recovery modal and the Connexions tab share. This is where the mapping from
 * the resolver's codes to what the UI shows is pinned.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationAgentResolution } from "@appstrate/shared-types";
import { describeResolution } from "../integration-run-readiness";

function resolution(over: Partial<IntegrationAgentResolution>): IntegrationAgentResolution {
  return {
    source: "fallback_auto",
    error_code: null,
    resolved_connection_ids: ["conn_1"],
    resolved_missing_scopes: [],
    admin_pinned_connection_ids: [],
    member_pinned_connection_ids: [],
    org_default_connection_ids: [],
    org_default_enforced: false,
    can_add_connection: true,
    candidates: [],
    ...over,
  };
}

describe("describeResolution — lock (stored configuration, not the verdict)", () => {
  it("an admin pin locks its own set", () => {
    const view = describeResolution(resolution({ admin_pinned_connection_ids: ["a", "b"] }));
    expect(view.lockedConnectionIds).toEqual(["a", "b"]);
  });

  it("an enforced org default locks the default's set", () => {
    const view = describeResolution(
      resolution({ org_default_connection_ids: ["d"], org_default_enforced: true }),
    );
    expect(view.lockedConnectionIds).toEqual(["d"]);
  });

  it("the admin pin wins over an enforced default, as in the cascade", () => {
    const view = describeResolution(
      resolution({
        admin_pinned_connection_ids: ["a"],
        org_default_connection_ids: ["d"],
        org_default_enforced: true,
      }),
    );
    expect(view.lockedConnectionIds).toEqual(["a"]);
  });

  it("locks even when the verdict names no admin layer", () => {
    const view = describeResolution(
      resolution({
        source: null,
        error_code: "auth_key_mismatch",
        admin_pinned_connection_ids: ["a"],
      }),
    );
    expect(view.lockedConnectionIds).toEqual(["a"]);
  });

  it("a soft org default does not lock", () => {
    const view = describeResolution(
      resolution({ source: "org_default", org_default_connection_ids: ["d"] }),
    );
    expect(view.lockedConnectionIds).toEqual([]);
  });
});

describe("describeResolution — (par défaut)", () => {
  it("marks what bound without anyone's pick: a soft org default or the own fallback", () => {
    expect(describeResolution(resolution({ source: "org_default" })).byDefault).toBe(true);
    expect(describeResolution(resolution({ source: "fallback_auto" })).byDefault).toBe(true);
  });

  it("never marks an explicit pick", () => {
    for (const source of ["admin_pin", "org_default_enforced", "member_pin", null] as const) {
      expect(describeResolution(resolution({ source })).byDefault).toBe(false);
    }
  });
});

describe("describeResolution — remedy", () => {
  it("is null when the set binds, however it was bound", () => {
    for (const source of ["admin_pin", "member_pin", "fallback_auto"] as const) {
      expect(describeResolution(resolution({ source, error_code: null })).remedy).toBeNull();
    }
  });

  it("is null when there is no verdict at all (no manifest loaded)", () => {
    expect(
      describeResolution(
        resolution({ source: null, error_code: null, resolved_connection_ids: [] }),
      ).remedy,
    ).toBeNull();
  });

  it("names the precise cause of every refusal", () => {
    const cases = [
      ["not_connected", "connect"],
      ["auth_key_mismatch", "connect"],
      ["must_choose_connection", "choose"],
      ["needs_reconnection", "reconnect"],
      ["insufficient_scopes", "upgrade"],
      ["pinned_connection_unavailable", "replace_unavailable"],
      ["override_connection_unavailable", "replace_unavailable"],
      ["auth_serves_no_selected_tool", "remove_unserving"],
    ] as const;
    for (const [error_code, remedy] of cases) {
      expect(describeResolution(resolution({ error_code })).remedy).toBe(remedy);
    }
  });
});
