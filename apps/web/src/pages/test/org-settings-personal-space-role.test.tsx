// SPDX-License-Identifier: Apache-2.0

/**
 * The « personal space role » switch of Settings › General: ON is today's default (`admin`), OFF
 * is the cap (`operator`); it is offered to `org:settings` alone, and each flip writes the stored
 * value. The web runner has no DOM, so a flip is pinned through the body it builds.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import settingsFr from "../../locales/fr/settings.json";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { PersonalSpaceRoleSetting } =
  await import("../../components/settings/personal-space-role-setting.tsx");
const { toggleBody, PERSONAL_SPACE_ROLE_VALUES: ROLE_VALUES } =
  await import("../../lib/org-setting-toggle-body.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const CREATED = "2026-07-01T10:00:00.000Z";

function renderSetting(permissions: string[], role: "admin" | "operator" | null): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [{ id: ORG_ID, name: "Acme", slug: "acme", role: "admin", permissions, createdAt: CREATED }],
  );
  if (role) {
    queryClient.setQueryData(
      ["get", "/api/orgs/{orgId}/settings", { params: { path: { orgId: ORG_ID } } }],
      { personal_model_credentials: true, personal_space_role: role },
    );
  }
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(<PersonalSpaceRoleSetting />, { queryClient });
  } finally {
    orgSnapshot.mockRestore();
  }
}

const switchOf = (html: string) => /<button[^>]*id="personal-space-role"[^>]*>/.exec(html)?.[0];

describe("the personal space role switch", () => {
  it("is ON when members are admin of their personal space", () => {
    const html = renderSetting(["org:settings"], "admin");
    expect(html).toContain(settingsFr["orgSettings.personalSpaceRoleTitle"]);
    expect(switchOf(html)).toContain('aria-checked="true"');
  });

  it("is OFF when members are capped to operator", () => {
    expect(switchOf(renderSetting(["org:settings"], "operator"))).toContain('aria-checked="false"');
  });

  it("is a skeleton, not a switch, until the settings load", () => {
    expect(switchOf(renderSetting(["org:settings"], null))).toBeUndefined();
  });

  it("is disabled without org:settings", () => {
    expect(switchOf(renderSetting([], "admin"))).toContain("disabled");
  });

  it("writes operator when flipped OFF, then admin when flipped back ON", () => {
    expect(toggleBody("personal_space_role", false, ROLE_VALUES)).toEqual({
      personal_space_role: "operator",
    });
    expect(toggleBody("personal_space_role", true, ROLE_VALUES)).toEqual({
      personal_space_role: "admin",
    });
  });

  it("keeps writing a boolean for the boolean settings", () => {
    expect(toggleBody("restrict_package_copy", true)).toEqual({ restrict_package_copy: true });
  });
});
