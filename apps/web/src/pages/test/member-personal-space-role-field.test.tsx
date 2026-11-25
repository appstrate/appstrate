// SPDX-License-Identifier: Apache-2.0

/** The « Rôle dans son espace personnel » field of the user sheet, in its three states. */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import settingsFr from "../../locales/fr/settings.json";
import type { components } from "../../api/client.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { PersonalSpaceRoleField, followLabel } =
  await import("../org-settings/member-personal-space-role-field.tsx");
const { FOLLOW_ORG_DEFAULT, memberOverrideToSelectValue } =
  await import("../../lib/personal-space-role.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

type OrgMember = components["schemas"]["OrgMember"];
const ORG_ID = "org_a";
const CUSTOM_ID = "srl_triage";

function member(role: OrgMember["role"], override: OrgMember["personal_space_role"]): OrgMember {
  return {
    userId: "usr_1",
    role,
    joinedAt: "2026-07-01T10:00:00.000Z",
    spaces: [],
    personal_space_role: override,
  };
}

function renderField(m: OrgMember, permissions: string[]): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [{ id: ORG_ID, name: "Acme", slug: "acme", role: "admin", permissions, createdAt: "x" }],
  );
  queryClient.setQueryData(["get", "/api/roles", { params: { header: { "X-Org-Id": ORG_ID } } }], {
    data: [
      { id: null, kind: "preset", key: "admin", name: "admin" },
      { id: null, kind: "preset", key: "operator", name: "operator" },
      { id: CUSTOM_ID, kind: "custom", key: "triage", name: "Triage" },
    ],
  });
  queryClient.setQueryData(
    ["get", "/api/orgs/{orgId}/settings", { params: { path: { orgId: ORG_ID } } }],
    { personal_model_credentials: true, personal_space_role: "operator" },
  );
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(<PersonalSpaceRoleField member={m} />, { queryClient });
  } finally {
    snapshot.mockRestore();
  }
}

const selectOf = (html: string) =>
  /<button[^>]*id="member-personal-space-role"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0];

describe("the personal space role field of the user sheet", () => {
  // A closed Radix select draws no value under `renderToStaticMarkup`: the control is checked
  // present, and what each state reads as is pinned through the mapping the field uses.
  it("draws the control for a member with an override and for one following the default", () => {
    for (const override of [
      { preset_role: "admin" as const },
      { custom_role_id: CUSTOM_ID },
      null,
    ]) {
      const html = renderField(member("member", override), ["members:change-role"]);
      expect(html).toContain(settingsFr["userDetail.personalSpaceRole"]);
      expect(selectOf(html)).toBeDefined();
    }
  });

  it("reads each override back to its select value", () => {
    expect(memberOverrideToSelectValue({ preset_role: "admin" })).toBe("preset:admin");
    expect(memberOverrideToSelectValue({ custom_role_id: CUSTOM_ID })).toBe(`custom:${CUSTOM_ID}`);
    expect(memberOverrideToSelectValue(null)).toBe(FOLLOW_ORG_DEFAULT);
  });

  it("names the org default a member follows; a guest holds operator", () => {
    const options = [
      { value: "preset:operator", label: "Opérateur" },
      { value: "preset:admin", label: "Admin" },
      { value: `custom:${CUSTOM_ID}`, label: "Triage" },
    ];
    expect(followLabel(member("member", null), options, "operator", "?")).toBe("Opérateur");
    expect(followLabel(member("member", null), options, CUSTOM_ID, "?")).toBe("Triage");
    expect(followLabel(member("member", null), options, undefined, "?")).toBe("Admin");
    expect(followLabel(member("guest", null), options, CUSTOM_ID, "?")).toBe("Opérateur");
    expect(followLabel(member("member", null), options, "srl_gone", "Rôle personnalisé")).toBe(
      "Rôle personnalisé",
    );
  });

  it("is read-only without members:change-role", () => {
    const html = renderField(member("member", null), []);
    expect(selectOf(html)).toBeUndefined();
    expect(html).toContain(settingsFr["userDetail.personalSpaceRoleFollowOrgBare"]);
  });

  it("is a fixed « Administrateur » for an admin or owner target", () => {
    for (const role of ["admin", "owner"] as const) {
      const html = renderField(member(role, null), ["members:change-role"]);
      expect(selectOf(html)).toBeUndefined();
      expect(html).toContain(settingsFr["userDetail.personalSpaceRoleAdminFixed"]);
      expect(html).toContain(settingsFr["userDetail.personalSpaceRoleAdminHint"]);
    }
  });
});
