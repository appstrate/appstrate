// SPDX-License-Identifier: Apache-2.0

/**
 * The « personal space role » picker of Settings › General: it lists the presets and the org's
 * custom roles, shows the stored value (a preset key or an `srl_` id), is offered to `org:settings`
 * alone, and writes the stored value. The web runner has no DOM, so a pick is pinned through the
 * body it builds.
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
const { toggleBody } = await import("../../lib/org-setting-toggle-body.ts");
const { orgPersonalSpaceRoleBody, storedRoleToSelectValue } =
  await import("../../lib/personal-space-role.ts");
const { useSpaceRoleOptions } = await import("../../hooks/use-roles.ts");
const { client, $api } = await import("../../api/client.ts");
const { useUpdateOrgSettings } = await import("../../hooks/use-org-settings.ts");
const { ApiError } = await import("../../api/errors.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const ORG_ID = "org_a";
const CREATED = "2026-07-01T10:00:00.000Z";

const CUSTOM_ID = "srl_triage";
const ROLES = [
  { id: null, kind: "preset", key: "admin", name: "admin" },
  { id: null, kind: "preset", key: "operator", name: "operator" },
  { id: CUSTOM_ID, kind: "custom", key: "triage", name: "Triage" },
];

function renderSetting(permissions: string[], role: string | null): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [{ id: ORG_ID, name: "Acme", slug: "acme", role: "admin", permissions, createdAt: CREATED }],
  );
  queryClient.setQueryData(["get", "/api/roles", { params: { header: { "X-Org-Id": ORG_ID } } }], {
    data: ROLES,
  });
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

const pickerOf = (html: string) =>
  /<button[^>]*id="personal-space-role"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0];

describe("the personal space role picker", () => {
  // A closed Radix select draws no value or item under `renderToStaticMarkup`, so the picker's
  // catalogue and the label of a stored value are read from the same hook and mapping it uses.
  function optionLabels(stored: string): { labels: string[]; shown: string | undefined } {
    const qc = new QueryClient();
    qc.setQueryData(
      ["orgs"],
      [
        {
          id: ORG_ID,
          name: "Acme",
          slug: "acme",
          role: "admin",
          permissions: ["roles:read"],
          createdAt: CREATED,
        },
      ],
    );
    qc.setQueryData(["get", "/api/roles", { params: { header: { "X-Org-Id": ORG_ID } } }], {
      data: ROLES,
    });
    let result = { labels: [] as string[], shown: undefined as string | undefined };
    function Probe() {
      const { options } = useSpaceRoleOptions();
      result = {
        labels: options.map((o) => o.label),
        shown: options.find((o) => o.value === storedRoleToSelectValue(stored))?.label,
      };
      return null;
    }
    const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: ORG_ID,
    });
    try {
      render(<Probe />, { queryClient: qc });
    } finally {
      snapshot.mockRestore();
    }
    return result;
  }

  it("offers the presets then the org's custom roles", () => {
    expect(optionLabels("admin").labels).toEqual([
      settingsFr["roles.preset.admin"],
      settingsFr["roles.preset.operator"],
      "Triage",
    ]);
  });

  it("shows the stored preset, and the name of a stored custom role", () => {
    expect(optionLabels("operator").shown).toBe(settingsFr["roles.preset.operator"]);
    expect(optionLabels(CUSTOM_ID).shown).toBe("Triage");
  });

  it("draws the title, the explanation and the picker", () => {
    const html = renderSetting(["org:settings"], CUSTOM_ID);
    expect(html).toContain(settingsFr["orgSettings.personalSpaceRoleTitle"]);
    expect(pickerOf(html)).toBeDefined();
  });

  it("is a skeleton, not a picker, until the settings load", () => {
    expect(pickerOf(renderSetting(["org:settings"], null))).toBeUndefined();
  });

  it("is disabled without org:settings", () => {
    expect(pickerOf(renderSetting([], "admin"))).toContain("disabled");
  });

  it("writes a preset key or a custom role id", () => {
    expect(orgPersonalSpaceRoleBody("preset:builder")).toEqual({ personal_space_role: "builder" });
    expect(orgPersonalSpaceRoleBody(`custom:${CUSTOM_ID}`)).toEqual({
      personal_space_role: CUSTOM_ID,
    });
  });

  it("keeps writing a boolean for the boolean settings", () => {
    expect(toggleBody("restrict_package_copy", true)).toEqual({ restrict_package_copy: true });
  });
});

it("keeps the cached toggle after a refused PATCH and refreshes it after a successful edit", async () => {
  const qc = new QueryClient();
  const path = "/api/orgs/{orgId}/settings";
  const params = { path: { orgId: ORG_ID } };
  const key = $api.queryOptions("get", path, { params }).queryKey;
  const saved = { personal_space_role: "admin" };
  qc.setQueryData(key, saved);
  const updates: ReturnType<typeof useUpdateOrgSettings>[] = [];
  function Probe() {
    updates.push(useUpdateOrgSettings());
    return null;
  }
  render(<Probe />, { queryClient: qc });
  const patch = spyOn(client, "PATCH")
    .mockRejectedValueOnce(new ApiError("forbidden", "Refused", 403))
    .mockResolvedValueOnce({ data: { ...saved, personal_space_role: "operator" } });
  const input = { params, body: orgPersonalSpaceRoleBody("preset:operator") };
  try {
    await expect(updates[0]!.mutateAsync(input)).rejects.toMatchObject({ status: 403 });
    expect(qc.getQueryData(key)).toEqual(saved);
    expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
    await updates[0]!.mutateAsync(input);
    expect(patch).toHaveBeenCalledWith(path, input);
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  } finally {
    patch.mockRestore();
  }
});
