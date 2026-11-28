// SPDX-License-Identifier: Apache-2.0

/** The « Rôle dans son espace personnel » field of the user sheet, for a caller who may change it. */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import settingsFr from "../../locales/fr/settings.json";
import type { components } from "../../api/client.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { PersonalSpaceRoleField } =
  await import("../org-settings/member-personal-space-role-field.tsx");
const { followLabel } = await import("../../lib/personal-space-role.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const { CUSTOM_ROLE_ID, ORG_ID, seedOrgAndRoles } =
  await import("../../test/personal-space-role-fixtures.ts");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

type OrgMember = components["schemas"]["OrgMember"];

function member(
  role: OrgMember["role"],
  override: OrgMember["personal_space_role"],
  defaultRole: OrgMember["personal_space_default_role"] = {
    preset_role: "admin",
    name: "admin",
  },
): OrgMember {
  return {
    userId: "usr_1",
    role,
    joinedAt: "2026-07-01T10:00:00.000Z",
    spaces: [],
    personal_space_role: override,
    personal_space_default_role: defaultRole,
  };
}

function renderField(m: OrgMember, permissions: string[]): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  seedOrgAndRoles(queryClient, permissions);
  queryClient.setQueryData(
    ["get", "/api/orgs/{orgId}/settings", { params: { path: { orgId: ORG_ID } } }],
    { personal_model_credentials: true, personal_space_role: { preset_role: "operator" } },
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
  // A closed select draws its chosen label but no item under `renderToStaticMarkup`: what the
  // other states read as is pinned through the mapping the field uses.
  it("draws the control for a member, naming the role it holds", () => {
    const html = renderField(member("member", { custom_role_id: CUSTOM_ROLE_ID }), [
      "members:change-role",
    ]);
    expect(html).toContain(settingsFr["userDetail.personalSpaceRole"]);
    expect(selectOf(html)).toContain("Triage");
  });

  it("names the default the server reports, as the role selects name it", () => {
    const t = (key: string) => i18nModule.default.t(key);
    const preset = { preset_role: "operator" as const, name: "operator" };
    const custom = { custom_role_id: "srl_00000000-0000-4000-8000-000000000001", name: "Triage" };
    expect(followLabel(member("member", null, preset), t)).toBe(
      settingsFr["roles.preset.operator"],
    );
    expect(followLabel(member("member", null, custom), t)).toBe("Triage");
  });

  it("says so when the org default names no role", () => {
    const t = (key: string) => i18nModule.default.t(key);
    const { personal_space_default_role: _omitted, ...bare } = member("member", null);
    expect(followLabel(bare, t)).toBe(settingsFr["userDetail.personalSpaceRoleNoDefault"]);
  });

  it("renders nothing without members:change-role, whatever the target", () => {
    for (const role of ["member", "guest", "admin", "owner"] as const) {
      expect(renderField(member(role, null), [])).toBe("");
    }
  });

  it("is a fixed « Administrateur » for an admin or owner target", () => {
    for (const role of ["admin", "owner"] as const) {
      const html = renderField(member(role, null), ["members:change-role"]);
      expect(selectOf(html)).toBeUndefined();
      expect(html).toContain(settingsFr["roles.preset.admin"]);
      expect(html).toContain(settingsFr["userDetail.personalSpaceRoleAdminHint"]);
    }
  });
});
