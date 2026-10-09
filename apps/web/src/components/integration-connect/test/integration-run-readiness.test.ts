// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `describeResolution` — the one reading of the server verdict
 * (`source` + `error_code`, the resolver's vocabulary) the picker and the
 * agent's integrations block share. This is where the
 * mapping from the resolver's codes to what the UI shows is pinned — and
 * `unboundLabel`, why a run starts without a declared integration (its launch
 * warning), and `requiredNoneLabel`, who chose none for one the agent requires.
 */

import { afterAll, describe, it, expect } from "bun:test";
import {
  CONNECTION_RESOLUTION_SOURCES,
  CONNECTION_RESOLUTION_WARNING_CODES,
} from "@appstrate/core/integration";
import type { components } from "../../../api/schema";
import i18n, { i18nReady } from "../../../i18n.ts";
import { describeResolution, requiredNoneLabel, unboundLabel } from "../integration-run-readiness";

type IntegrationAgentResolution = components["schemas"]["IntegrationAgentResolution"];
type Warning = NonNullable<IntegrationAgentResolution["warning"]>;

await i18nReady;
await i18n.changeLanguage("fr");
afterAll(async () => {
  await i18n.changeLanguage("fr");
});

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
    warning: null,
    resolved_connection_ids: ["conn_1"],
    resolved_missing_scopes: [],
    admin_pinned_connection_ids: null,
    member_pinned_connection_ids: null,
    org_default_connection_ids: null,
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
    // the agent block's reuse hint must not read that as "ready".
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

  it("asks for a pick when the run starts without it for want of one", () => {
    const shared = { ...candidate(), is_own: false };
    const unbound = (code: Warning["code"]) =>
      resolution({
        source: null,
        resolved_connection_ids: [],
        candidates: [shared],
        warning: warning(code),
      });
    expect(describeResolution(unbound("must_choose_connection")).emptyPickerPrompt).toBe("choose");
    // Control: the same shared candidate under another cause asks for a connection.
    expect(describeResolution(unbound("not_connected")).emptyPickerPrompt).toBe("connect");
    expect(describeResolution(unbound("auth_key_mismatch")).emptyPickerPrompt).toBe("connect");
  });
});

describe("describeResolution — no org default", () => {
  it("reads a null org default as no lock and no soft set", () => {
    const view = describeResolution(
      resolution({ source: "org_default", org_default_connection_ids: null }),
    );
    expect(view.lockedBy).toBeNull();
    expect(view.softDefaultIds).toEqual([]);
  });
});

function warning(code: Warning["code"], over: Partial<Warning> = {}): Warning {
  return { field: "integrations.@acme/gmail", code, message: "server prose", ...over };
}

describe("unboundLabel", () => {
  it("is null when the run starts with it", () => {
    expect(unboundLabel(null)).toBeNull();
  });

  it("words every warning code, in French", () => {
    for (const code of CONNECTION_RESOLUTION_WARNING_CODES) {
      const label = unboundLabel(warning(code));
      expect(label).toBeString();
      expect(label).not.toContain("detail.");
    }
    expect(unboundLabel(warning("not_connected"))).toBe("Non connectée — l'agent s'exécute sans");
    expect(unboundLabel(warning("must_choose_connection"))).toBe(
      "Seules des connexions partagées existent — choisissez-en une pour l'utiliser",
    );
    expect(unboundLabel(warning("auth_key_mismatch"))).toBe(
      "Connectée avec une autre méthode d'authentification — l'agent s'exécute sans",
    );
    expect(unboundLabel(warning("integration_not_active"))).toBe(
      "Désactivée dans cet espace — l'agent s'exécute sans",
    );
  });

  it("names the layer that chose no connection, from the warning's `source`", () => {
    expect(unboundLabel(warning("integration_unbound", { source: "member_pin" }))).toBe(
      "Aucune connexion (votre choix) — l'agent s'exécute sans",
    );
    expect(unboundLabel(warning("integration_unbound", { source: "admin_pin" }))).toBe(
      "Aucune connexion (choix d'un admin) — l'agent s'exécute sans",
    );
    const phrases = CONNECTION_RESOLUTION_SOURCES.filter((s) => s !== "fallback_auto").map(
      (source) => unboundLabel(warning("integration_unbound", { source })),
    );
    expect(new Set(phrases).size).toBe(phrases.length);
    for (const phrase of phrases) expect(phrase).not.toContain("noneChosenBy.");
    // No layer named: the sentence claims nobody.
    expect(unboundLabel(warning("integration_unbound"))).toBe(
      "Aucune connexion — l'agent s'exécute sans",
    );
  });
});

describe("requiredNoneLabel", () => {
  const refused = {
    error_code: "required_integration_unbound" as const,
    resolved_connection_ids: [],
  };

  it("names the layer whose set is empty, from `source`", () => {
    expect(requiredNoneLabel(resolution({ ...refused, source: "admin_pin" }))).toBe(
      "Aucune connexion (choix d'un admin) alors que l'agent l'exige — lancement bloqué",
    );
    expect(requiredNoneLabel(resolution({ ...refused, source: "org_default_enforced" }))).toBe(
      "Aucune connexion (défaut imposé de l'espace) alors que l'agent l'exige — lancement bloqué",
    );
  });

  it("still says none was chosen when no layer is named", () => {
    expect(requiredNoneLabel(resolution({ ...refused, source: null }))).toBe(
      "Aucune connexion choisie alors que l'agent l'exige — lancement bloqué",
    );
  });

  it("is null for any other verdict, a warning included", () => {
    expect(requiredNoneLabel(resolution({}))).toBeNull();
    expect(
      requiredNoneLabel(
        resolution({
          source: null,
          error_code: null,
          warning: warning("integration_unbound", { source: "member_pin" }),
        }),
      ),
    ).toBeNull();
    expect(
      requiredNoneLabel(resolution({ ...refused, error_code: "must_choose_connection" })),
    ).toBeNull();
  });
});
