// SPDX-License-Identifier: Apache-2.0

/**
 * Parity guard for OAuth scope labels.
 *
 * Two independent surfaces present a scope to a human:
 *
 *  - the hosted consent screen (`modules/oidc/pages/consent.ts`, server-rendered
 *    French HTML) — where the user actually grants the authorization;
 *  - the dashboard's OAuth-client editor (`apps/web/src/locales/{fr,en}/settings.json`,
 *    i18next keys `oauthClients.scopeLabels.*`) — where an admin picks the scopes.
 *
 * They are deliberately NOT unified: different rendering stacks (server HTML vs
 * i18next in the SPA), and the consent page is French-only by design. What must
 * not happen is a scope existing in the authoritative vocabulary with no label
 * on either surface: both fall back to the raw scope string, so the failure is
 * silent — the user is asked to authorize `llm-proxy:call` verbatim. That is a
 * consent defect, not a cosmetic one, and it is exactly what this test catches.
 *
 * Authority = `APPSTRATE_BUILTIN_SCOPES` (identity scopes + `OIDC_ALLOWED_SCOPES`).
 * Module-contributed scopes (`mcp:read`, `mcp:invoke`, added at runtime by
 * `getAppstrateScopes()` when the module is loaded) are labelled on both
 * surfaces too, but are not asserted here — enumerating them would mean booting
 * the module registry inside a unit test.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { APPSTRATE_BUILTIN_SCOPES } from "../../src/modules/oidc/auth/scopes.ts";
import { SCOPE_DESCRIPTIONS_FR } from "../../src/modules/oidc/pages/consent.ts";

const LOCALES_DIR = join(import.meta.dir, "../../../web/src/locales");

async function scopeLabelKeys(locale: "fr" | "en"): Promise<Set<string>> {
  const file = (await Bun.file(join(LOCALES_DIR, locale, "settings.json")).json()) as Record<
    string,
    string
  >;
  const prefix = "oauthClients.scopeLabels.";
  return new Set(
    Object.entries(file)
      .filter(([key, value]) => key.startsWith(prefix) && value.trim().length > 0)
      .map(([key]) => key.slice(prefix.length)),
  );
}

describe("OAuth scope labels", () => {
  it("the consent screen describes every authoritative scope", () => {
    const missing = APPSTRATE_BUILTIN_SCOPES.filter((scope) => !SCOPE_DESCRIPTIONS_FR[scope]);
    expect(missing).toEqual([]);
  });

  it("the dashboard locales label every authoritative scope (fr + en)", async () => {
    const [fr, en] = await Promise.all([scopeLabelKeys("fr"), scopeLabelKeys("en")]);
    expect(APPSTRATE_BUILTIN_SCOPES.filter((scope) => !fr.has(scope))).toEqual([]);
    expect(APPSTRATE_BUILTIN_SCOPES.filter((scope) => !en.has(scope))).toEqual([]);
  });

  it("fr and en label exactly the same scopes", async () => {
    const [fr, en] = await Promise.all([scopeLabelKeys("fr"), scopeLabelKeys("en")]);
    expect([...fr].sort()).toEqual([...en].sort());
  });
});
