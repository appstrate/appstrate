// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `describeResolution` — the one reading of the server verdict
 * (`source` + `error_code`, the resolver's vocabulary) the picker, the 409
 * recovery modal and the agent's integrations block share. This is where the
 * mapping from the resolver's codes to what the UI shows is pinned — and
 * `unboundReason`, why a run starts without a declared integration.
 */

import { describe, it, expect } from "bun:test";
import type { IntegrationAgentResolution } from "@appstrate/shared-types";
import { describeResolution, unboundReason } from "../integration-run-readiness";

function candidate(): IntegrationAgentResolution["candidates"][number] {
  return {
    id: "conn_1",
    auth_key: "oauth",
    account_id: "me@acme.test",
    label: "Moi",
    owner_user_id: "usr_me",
    owner_end_user_id: null,
    owner_name: "Moi",
    scopes_granted: [],
    shared_with_org: false,
    needs_reconnection: false,
    missing_scopes: [],
    is_own: true,
  };
}

function resolution(over: Partial<IntegrationAgentResolution>): IntegrationAgentResolution {
  return {
    source: "fallback_auto",
    error_code: null,
    warning_code: null,
    resolved_connection_ids: ["conn_1"],
    resolved_missing_scopes: [],
    admin_pinned_connection_ids: null,
    member_pinned_connection_ids: null,
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
    expect(view.lockedBy).toBe("admin_pin");
  });

  it("an enforced org default locks the default's set", () => {
    const view = describeResolution(
      resolution({ org_default_connection_ids: ["d"], org_default_enforced: true }),
    );
    expect(view.lockedConnectionIds).toEqual(["d"]);
    expect(view.lockedBy).toBe("org_default");
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

  it("an admin pin to none locks too — to nothing, over an enforced default", () => {
    const view = describeResolution(
      resolution({
        admin_pinned_connection_ids: [],
        org_default_connection_ids: ["d"],
        org_default_enforced: true,
      }),
    );
    expect(view.lockedBy).toBe("admin_pin");
    expect(view.lockedConnectionIds).toEqual([]);
  });

  it("a soft org default does not lock", () => {
    const view = describeResolution(
      resolution({ source: "org_default", org_default_connection_ids: ["d"] }),
    );
    expect(view.lockedConnectionIds).toEqual([]);
    expect(view.lockedBy).toBeNull();
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

describe("describeResolution — soft default set", () => {
  it("is the stored default, whole, while the soft default is the layer in play", () => {
    for (const error_code of [
      null,
      "auth_serves_no_selected_tool",
      "pinned_connection_unavailable",
    ] as const) {
      const view = describeResolution(
        resolution({ source: "org_default", error_code, org_default_connection_ids: ["a", "b"] }),
      );
      expect(view.softDefaultIds).toEqual(["a", "b"]);
    }
  });

  it("is empty when another layer is in play, the enforced default included", () => {
    for (const source of ["member_pin", "fallback_auto", "org_default_enforced", null] as const) {
      const view = describeResolution(resolution({ source, org_default_connection_ids: ["a"] }));
      expect(view.softDefaultIds).toEqual([]);
    }
  });
});

describe("describeResolution — empty picker prompt", () => {
  it("asks for a pick, a connection, or the agent's reconfiguration", () => {
    const cases = [
      ["must_choose_connection", "choose"],
      ["not_connected", "connect"],
      ["needs_reconnection", "connect"],
      ["auth_key_mismatch", "connect"],
      // The agent's own auth_key serves none of its selected tools: no connection clears it.
      ["auth_key_serves_no_selected_tool", "reconfigure"],
      [null, "connect"],
    ] as const;
    for (const [error_code, prompt] of cases) {
      expect(describeResolution(resolution({ error_code })).emptyPickerPrompt).toBe(prompt);
    }
  });
});

describe("unboundReason", () => {
  const entry = (run_blocking: boolean, over: Partial<IntegrationAgentResolution>) => ({
    run_blocking,
    resolution: resolution(over),
  });
  const empty = {
    source: null,
    error_code: null,
    warning_code: "integration_unbound" as const,
    resolved_connection_ids: [],
  };
  const shared = { ...candidate(), is_own: false };

  it("is null while a set binds with no error", () => {
    expect(unboundReason(entry(false, {}))).toBeNull();
  });

  it("names an integration switched off in the space before any pin", () => {
    expect(
      unboundReason(
        entry(false, {
          ...empty,
          warning_code: "integration_not_active",
          admin_pinned_connection_ids: [],
          candidates: [{ ...candidate(), is_own: false }],
        }),
      ),
    ).toBe("inactive");
  });

  it("names a pin to none — an admin's over the member's", () => {
    expect(unboundReason(entry(false, { ...empty, admin_pinned_connection_ids: [] }))).toBe(
      "admin_none",
    );
    expect(
      unboundReason(
        entry(false, {
          ...empty,
          admin_pinned_connection_ids: [],
          member_pinned_connection_ids: [],
        }),
      ),
    ).toBe("admin_none");
    expect(unboundReason(entry(false, { ...empty, member_pinned_connection_ids: [] }))).toBe(
      "member_none",
    );
  });

  it("tells only-shared connections from nothing usable", () => {
    expect(unboundReason(entry(false, { ...empty, candidates: [shared] }))).toBe("shared_only");
    expect(unboundReason(entry(false, empty))).toBe("not_connected");
    // Control: an own candidate left unbound is no shared-only case.
    expect(unboundReason(entry(false, { ...empty, candidates: [candidate()] }))).toBe(
      "not_connected",
    );
  });

  it("is null whenever the server says the run is refused over it", () => {
    expect(
      unboundReason(entry(true, { ...empty, error_code: "required_integration_unbound" })),
    ).toBeNull();
    expect(unboundReason(entry(true, empty))).toBeNull();
  });

  it("is null for a non-blocking error: an inert integration's verdict is no unbound state", () => {
    expect(
      unboundReason(entry(false, { ...empty, error_code: "must_choose_connection" })),
    ).toBeNull();
  });
});
