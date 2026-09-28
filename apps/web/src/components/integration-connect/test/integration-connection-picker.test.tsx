// SPDX-License-Identifier: Apache-2.0

/**
 * The picker when a member of the stored set is unusable — gone (deleted or
 * unshared by its owner), or on an auth serving none of the selected tools. The
 * server keeps refusing the set — it never binds what is left — so the picker
 * must say so, instead of showing the survivors as if they were the whole
 * selection.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../../api/client.ts";
import i18n, { i18nReady } from "../../../i18n.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { render } from "../../../test/render.tsx";
import type { IntegrationManifestView } from "../../../hooks/use-integrations.ts";
import { IntegrationConnectionPicker } from "../integration-connection-picker.tsx";

await i18nReady;
await i18n.changeLanguage("fr");
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

type Resolution = components["schemas"]["IntegrationAgentResolution"];
type Candidate = Resolution["candidates"][number];

const INTEGRATION = "@acme/ssh";
const AGENT = "@acme/ops";
const WEB = "11111111-1111-4111-8111-111111111111";
const DB = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";

const MANIFEST = {
  auths: { primary: { type: "custom" } },
} as unknown as IntegrationManifestView;

function candidate(id: string, label: string): Candidate {
  return {
    id,
    auth_key: "primary",
    account_id: `root@${label}`,
    label,
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

function resolution(overrides: Partial<Resolution>): Resolution {
  return {
    source: "member_pin",
    error_code: null,
    resolved_connection_ids: [],
    resolved_missing_scopes: [],
    admin_pinned_connection_ids: [],
    member_pinned_connection_ids: [],
    org_default_connection_ids: [],
    org_default_enforced: false,
    can_add_connection: true,
    candidates: [candidate(WEB, "web"), candidate(DB, "db")],
    ...overrides,
  };
}

/** Seed the one readiness query the picker reads, under the key it builds. */
function renderPicker(res: Resolution, runBlocking: boolean): string {
  const qc = new QueryClient();
  const { queryKey } = $api.queryOptions("get", "/api/agents/{scope}/{name}/connection-readiness", {
    params: {
      path: { scope: "@acme", name: "ops" },
      header: { "X-Org-Id": undefined, "X-Space-Id": undefined },
    },
  });
  qc.setQueryData(queryKey, {
    blocks_run: runBlocking,
    errors: [],
    integrations: [{ integration_id: INTEGRATION, run_blocking: runBlocking, resolution: res }],
  });
  return render(
    <IntegrationConnectionPicker
      integrationId={INTEGRATION}
      agentPackageId={AGENT}
      manifest={MANIFEST}
      authStatuses={[]}
      agentTools={undefined}
      agentScopes={undefined}
    />,
    { queryClient: qc },
  );
}

const WARNING = `member-pick-unavailable-warning-${INTEGRATION}`;

describe("IntegrationConnectionPicker — a stored member is gone", () => {
  it("counts the whole stored set and names how many are unavailable", () => {
    const html = renderPicker(
      resolution({
        error_code: "pinned_connection_unavailable",
        member_pinned_connection_ids: [WEB, GONE],
      }),
      true,
    );
    const label = `${i18n.t("agents:detail.integrationMemberPicker.selectedCount", { count: 2 })} · ${i18n.t(
      "agents:detail.integrationMemberPicker.unavailableCount",
      { count: 1 },
    )}`;
    expect(html).toContain(label);
    expect(html).toContain(WARNING);
    expect(html).toContain(
      i18n.t("agents:detail.integrationMemberPicker.unavailableWarning", { count: 1 }),
    );
  });

  it("shows neither the count nor the warning while every stored member is reachable", () => {
    const html = renderPicker(
      resolution({ member_pinned_connection_ids: [WEB, DB], resolved_connection_ids: [WEB, DB] }),
      false,
    );
    expect(html).not.toContain(WARNING);
    expect(html).toContain(
      i18n.t("agents:detail.integrationMemberPicker.selectedCount", { count: 2 }),
    );
  });

  it("keeps the menu reachable when nothing is left to pick, so the stored set can be reset", () => {
    const html = renderPicker(
      resolution({
        error_code: "pinned_connection_unavailable",
        member_pinned_connection_ids: [GONE],
        candidates: [],
        can_add_connection: false,
      }),
      true,
    );
    expect(html).not.toContain(`member-pick-blocked-${INTEGRATION}`);
    expect(html).toContain(`member-pick-${INTEGRATION}`);
    expect(html).toContain(WARNING);
  });

  it("warns in override mode too — a schedule would fail at every fire", () => {
    const html = render(
      <IntegrationConnectionPicker
        integrationId={INTEGRATION}
        agentPackageId={AGENT}
        manifest={MANIFEST}
        authStatuses={[]}
        agentTools={undefined}
        agentScopes={undefined}
        persistence={{ mode: "override", value: [DB, GONE], onChange: () => {} }}
      />,
      {
        queryClient: (() => {
          const qc = new QueryClient();
          const { queryKey } = $api.queryOptions(
            "get",
            "/api/agents/{scope}/{name}/connection-readiness",
            {
              params: {
                path: { scope: "@acme", name: "ops" },
                header: { "X-Org-Id": undefined, "X-Space-Id": undefined },
              },
            },
          );
          qc.setQueryData(queryKey, {
            blocks_run: false,
            errors: [],
            integrations: [
              { integration_id: INTEGRATION, run_blocking: false, resolution: resolution({}) },
            ],
          });
          return qc;
        })(),
      },
    );
    expect(html).toContain(WARNING);
    expect(html).toContain("text-amber-600");
  });
});

describe("IntegrationConnectionPicker — the verdict's precise cause", () => {
  const t = (key: string, opts?: Record<string, unknown>) =>
    i18n.t(`agents:detail.integrationMemberPicker.${key}`, opts);

  it("a pinned member on an auth serving no selected tool is flagged like a gone one", () => {
    // The candidates leave the unserving row out, as the 409 does; the one
    // "unavailable for this agent" wording covers that cause too.
    const html = renderPicker(
      resolution({
        error_code: "auth_serves_no_selected_tool",
        member_pinned_connection_ids: [WEB, GONE],
        resolved_connection_ids: [WEB, GONE],
      }),
      true,
    );
    expect(html).toContain(
      `${t("selectedCount", { count: 2 })} · ${t("unavailableCount", { count: 1 })}`,
    );
    expect(html).toContain(t("unavailableWarning", { count: 1 }));
  });

  it("a soft default with a member serving no selected tool is named whole", () => {
    // {WEB serves, GONE does not}: the candidates hold WEB alone, so reading the
    // trigger off them showed one bound connection where the run is refused.
    const html = renderPicker(
      resolution({
        source: "org_default",
        error_code: "auth_serves_no_selected_tool",
        org_default_connection_ids: [WEB, GONE],
        resolved_connection_ids: [WEB, GONE],
      }),
      true,
    );
    expect(html).toContain(
      `${t("selectedCount", { count: 2 })} · ${t("unavailableCount", { count: 1 })}`,
    );
    expect(html).toContain(t("defaultBadge"));
    expect(html).toContain(t("defaultUnavailableWarning", { count: 1 }));
    expect(html).not.toContain(t("unavailableWarning", { count: 1 }));
  });

  it("a soft default naming an unreachable connection says the default is unavailable", () => {
    // Nothing resolved: this used to read "Connecter (par défaut)".
    const html = renderPicker(
      resolution({
        source: "org_default",
        error_code: "pinned_connection_unavailable",
        org_default_connection_ids: [GONE],
      }),
      true,
    );
    expect(html).not.toContain(t("connectLabel"));
    expect(html).toContain(
      `${t("selectedCount", { count: 1 })} · ${t("unavailableCount", { count: 1 })}`,
    );
    expect(html).toContain(WARNING);
    expect(html).toContain(t("defaultUnavailableWarning", { count: 1 }));
  });

  it("a member pin over a broken soft default speaks for the pin alone", () => {
    const html = renderPicker(
      resolution({
        member_pinned_connection_ids: [WEB],
        resolved_connection_ids: [WEB],
        org_default_connection_ids: [GONE],
      }),
      false,
    );
    expect(html).not.toContain(WARNING);
  });

  it("an unpinned must_choose asks for a choice", () => {
    const html = renderPicker(
      resolution({ source: null, error_code: "must_choose_connection" }),
      true,
    );
    expect(html).toContain(t("chooseLabel"));
  });

  it("marks a fallback-bound connection as the default", () => {
    const html = renderPicker(
      resolution({ source: "fallback_auto", resolved_connection_ids: [WEB] }),
      false,
    );
    expect(html).toContain(t("defaultBadge"));
  });

  it("locks the dropdown on a stored admin pin, whatever the verdict names", () => {
    // `auth_key_mismatch` names no layer, yet the admin pin would still override any pick.
    const html = renderPicker(
      resolution({
        source: null,
        error_code: "auth_key_mismatch",
        admin_pinned_connection_ids: [WEB],
      }),
      true,
    );
    expect(html).toContain(`member-pick-locked-${INTEGRATION}`);
  });

  it("a soft org default leaves the dropdown open", () => {
    const html = renderPicker(
      resolution({ source: "org_default", org_default_connection_ids: [WEB] }),
      false,
    );
    expect(html).not.toContain(`member-pick-locked-${INTEGRATION}`);
    expect(html).toContain(`member-pick-${INTEGRATION}`);
  });
});
