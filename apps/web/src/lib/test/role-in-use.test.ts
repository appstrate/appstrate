// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { roleInUseMessage } = await import("../role-in-use.ts");
const i18nModule = await import("../../i18n.ts");
await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const t = i18nModule.default.getFixedT("fr", "settings");

describe("roleInUseMessage", () => {
  it("names the sign-up policies that still assign the role, singular and plural", () => {
    expect(roleInUseMessage({ signup_assignment_count: 1 }, t)).toBe(
      "1 politique d’inscription l’attribue encore.",
    );
    expect(roleInUseMessage({ signup_assignment_count: 3 }, t)).toBe(
      "3 politiques d’inscription l’attribuent encore.",
    );
  });

  it("joins every kind of holder the refusal counts, the org default first", () => {
    expect(
      roleInUseMessage(
        {
          org_default: true,
          member_count: 2,
          pending_invitation_count: 1,
          signup_assignment_count: 1,
        },
        t,
      ),
    ).toBe(
      [
        t("roles.inUseOrgDefault"),
        t("roles.inUse", { count: 2 }),
        t("roles.inUseInvitations", { count: 1 }),
        t("roles.inUseSignupPolicies", { count: 1 }),
      ].join(" "),
    );
  });

  it("falls back to the member sentence when nothing is counted", () => {
    expect(roleInUseMessage(undefined, t)).toBe(t("roles.inUse", { count: 0 }));
  });
});
