// SPDX-License-Identifier: Apache-2.0

/**
 * The « personal space role » picker of Settings › General: it lists the presets and the org's
 * custom roles, is offered to `org:settings` alone, and writes a preset key or an `srl_` id. The
 * web runner has no DOM, so a pick is pinned through the body it builds.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";
import settingsFr from "../../locales/fr/settings.json";
import type { SpaceRoleReference } from "../../hooks/use-roles.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { PersonalSpaceRoleSetting } =
  await import("../../components/settings/personal-space-role-setting.tsx");
const { toggleBody } = await import("../../lib/org-setting-toggle-body.ts");
const { orgPersonalSpaceRoleBody, personalSpaceRoleImpactDescription, pickPersonalSpaceRole } =
  await import("../../lib/personal-space-role.ts");
const { useSpaceRoleOptions } = await import("../../hooks/use-roles.ts");
const { client, $api } = await import("../../api/client.ts");
const { usePersonalSpaceRoleImpact, useUpdateOrgSettings } =
  await import("../../hooks/use-org-settings.ts");
const { ApiError } = await import("../../api/errors.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const { CUSTOM_ROLE_ID, ORG_ID, seedOrgAndRoles } =
  await import("../../test/personal-space-role-fixtures.ts");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

function renderSetting(permissions: string[], role: SpaceRoleReference | null): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  seedOrgAndRoles(queryClient, permissions);
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
  // A closed select draws no item under `renderToStaticMarkup`, so the picker's catalogue
  // is read from the hook it uses.
  function optionLabels(): string[] {
    const qc = new QueryClient();
    seedOrgAndRoles(qc, ["roles:read"]);
    let labels: string[] = [];
    function Probe() {
      labels = useSpaceRoleOptions().options.map((o) => o.label);
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
    return labels;
  }

  it("offers the presets then the org's custom roles", () => {
    expect(optionLabels()).toEqual([
      settingsFr["roles.preset.admin"],
      settingsFr["roles.preset.operator"],
      "Triage",
    ]);
  });

  it("draws the title, the explanation and the picker", () => {
    const html = renderSetting(["org:settings"], { custom_role_id: CUSTOM_ROLE_ID });
    expect(html).toContain(settingsFr["orgSettings.personalSpaceRoleTitle"]);
    expect(pickerOf(html)).toBeDefined();
  });

  it("is a skeleton, not a picker, until the settings load", () => {
    expect(pickerOf(renderSetting(["org:settings"], null))).toBeUndefined();
  });

  it("is disabled without org:settings", () => {
    expect(pickerOf(renderSetting([], { preset_role: "admin" }))).toContain("disabled");
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
  const saved = { personal_space_role: { preset_role: "admin" } };
  qc.setQueryData(key, saved);
  const updates: ReturnType<typeof useUpdateOrgSettings>[] = [];
  function Probe() {
    updates.push(useUpdateOrgSettings());
    return null;
  }
  render(<Probe />, { queryClient: qc });
  const patch = spyOn(client, "PATCH")
    .mockRejectedValueOnce(new ApiError("forbidden", "Refused", 403))
    .mockResolvedValueOnce({
      data: { ...saved, personal_space_role: { preset_role: "operator" } },
    });
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

describe("picking a default that would stop schedules", () => {
  const impactPath = "/api/orgs/{orgId}/personal-space-role/impact";
  const settingsPath = "/api/orgs/{orgId}/settings";

  const impactResponse = (data: { schedules: number; members: number }) =>
    ({ data, response: new Response(JSON.stringify(data), { status: 200 }) }) as never;

  /** The impact reader and the settings write the setting wires, from one render. */
  function wiring() {
    const qc = new QueryClient();
    let hooks: {
      impactOf: ReturnType<typeof usePersonalSpaceRoleImpact>;
      update: ReturnType<typeof useUpdateOrgSettings>;
    } | null = null;
    function Probe() {
      hooks = { impactOf: usePersonalSpaceRoleImpact(), update: useUpdateOrgSettings() };
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
    const { impactOf, update } = hooks!;
    const writes: Promise<unknown>[] = [];
    const write = (next: string) => {
      writes.push(
        update.mutateAsync({
          params: { path: { orgId: ORG_ID } },
          body: orgPersonalSpaceRoleBody(next),
        }),
      );
    };
    return {
      impactOf: (role: Parameters<typeof impactOf>[1]) => impactOf(ORG_ID, role),
      write,
      writes,
    };
  }

  it("asks with the counts, and writes only on confirm", async () => {
    const get = spyOn(client, "GET").mockResolvedValue(
      impactResponse({ schedules: 3, members: 2 }),
    );
    const patch = spyOn(client, "PATCH").mockResolvedValue({
      data: { personal_space_role: { preset_role: "viewer" } },
    });
    try {
      const { impactOf, write, writes } = wiring();
      const asked: { selectValue: string; impact: { schedules: number; members: number } }[] = [];
      await pickPersonalSpaceRole("preset:viewer", {
        impactOf,
        write,
        askConfirmation: (pending) => asked.push(pending),
      });
      expect(get).toHaveBeenCalledWith(impactPath, {
        params: { path: { orgId: ORG_ID }, query: { preset_role: "viewer" } },
        signal: expect.anything(),
      });
      expect(asked).toEqual([
        { selectValue: "preset:viewer", impact: { schedules: 3, members: 2 } },
      ]);
      expect(patch).not.toHaveBeenCalled();

      const description = personalSpaceRoleImpactDescription(
        i18nModule.default.t.bind(i18nModule.default),
        asked[0]!.impact,
      );
      expect(description).toContain("3 planifications actives de 2 membres seront désactivées");
      expect(description).toContain("ne se réactiveront pas si vous revenez en arrière");

      // What « Appliquer quand même » does: the held pick is written.
      write(asked[0]!.selectValue);
      await Promise.all(writes);
      expect(patch).toHaveBeenCalledWith(settingsPath, {
        params: { path: { orgId: ORG_ID } },
        body: { personal_space_role: { preset_role: "viewer" } },
      });
    } finally {
      get.mockRestore();
      patch.mockRestore();
    }
  });

  it("says one schedule of one member in the singular", () => {
    expect(
      personalSpaceRoleImpactDescription(i18nModule.default.t.bind(i18nModule.default), {
        schedules: 1,
        members: 1,
      }),
    ).toContain("1 planification active de 1 membre sera désactivée à son prochain déclenchement");
  });

  it("writes at once, with no confirmation, when nothing would stop", async () => {
    const get = spyOn(client, "GET").mockResolvedValue(
      impactResponse({ schedules: 0, members: 0 }),
    );
    const patch = spyOn(client, "PATCH").mockResolvedValue({
      data: { personal_space_role: { custom_role_id: CUSTOM_ROLE_ID } },
    });
    try {
      const { impactOf, write, writes } = wiring();
      let asked = false;
      await pickPersonalSpaceRole(`custom:${CUSTOM_ROLE_ID}`, {
        impactOf,
        write,
        askConfirmation: () => (asked = true),
      });
      await Promise.all(writes);
      expect(asked).toBe(false);
      expect(get.mock.calls[0]?.[1]).toMatchObject({
        params: { query: { custom_role_id: CUSTOM_ROLE_ID } },
      });
      expect(patch).toHaveBeenCalledWith(settingsPath, {
        params: { path: { orgId: ORG_ID } },
        body: { personal_space_role: { custom_role_id: CUSTOM_ROLE_ID } },
      });
    } finally {
      get.mockRestore();
      patch.mockRestore();
    }
  });

  it("writes nothing, and rejects, when the impact cannot be read", async () => {
    const get = spyOn(client, "GET").mockRejectedValue(new ApiError("internal", "Boom", 500));
    const patch = spyOn(client, "PATCH");
    try {
      const { impactOf, write } = wiring();
      let asked = false;
      await expect(
        pickPersonalSpaceRole("preset:viewer", {
          impactOf,
          write,
          askConfirmation: () => (asked = true),
        }),
      ).rejects.toMatchObject({ status: 500 });
      expect(asked).toBe(false);
      expect(patch).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      patch.mockRestore();
    }
  });
});
