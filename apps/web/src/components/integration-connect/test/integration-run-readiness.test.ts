// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `describeResolution` — the one reading of the server verdict
 * (`source` + `error_code`, the resolver's vocabulary) the picker, the 409
 * recovery modal and the agent's integrations block share. This is where the
 * mapping from the resolver's codes to what the UI shows is pinned.
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

describe("describeResolution — resolved", () => {
  it("holds when connections bind with no error, however they were bound", () => {
    for (const source of ["admin_pin", "member_pin", "fallback_auto"] as const) {
      expect(describeResolution(resolution({ source, error_code: null })).resolved).toBe(true);
    }
  });

  it("does not hold when there is no verdict at all (no manifest loaded)", () => {
    // `source` and `error_code` both null: nothing bound, nothing refused —
    // the recovery modal and the reuse hint must not read that as "ready".
    expect(
      describeResolution(
        resolution({ source: null, error_code: null, resolved_connection_ids: [] }),
      ).resolved,
    ).toBe(false);
  });

  it("does not hold on any refusal", () => {
    for (const error_code of [
      "not_connected",
      "must_choose_connection",
      "needs_reconnection",
      "override_connection_unavailable",
    ] as const) {
      expect(describeResolution(resolution({ error_code })).resolved).toBe(false);
    }
  });
});

describe("describeResolution — empty picker prompt", () => {
  it("asks for a pick, a removal, or a connection", () => {
    const cases = [
      ["must_choose_connection", "choose"],
      ["auth_serves_no_selected_tool", "remove_unserving"],
      ["not_connected", "connect"],
      ["needs_reconnection", "connect"],
      [null, "connect"],
    ] as const;
    for (const [error_code, prompt] of cases) {
      expect(describeResolution(resolution({ error_code })).emptyPickerPrompt).toBe(prompt);
    }
  });
});
