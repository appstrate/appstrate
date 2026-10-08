// SPDX-License-Identifier: Apache-2.0

/**
 * The picker when a member of the stored set is unusable — gone (deleted or
 * unshared by its owner), or on an auth serving none of the selected tools. The
 * server keeps refusing the set — it never binds what is left — so the picker
 * must say so, instead of showing the survivors as if they were the whole
 * selection. Plus how the picker reads the connection a connect popup created.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { toast } from "sonner";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { $api, type components } from "../../../api/client.ts";
import { ApiError } from "../../../api/errors.ts";
import i18n, { i18nReady } from "../../../i18n.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { render } from "../../../test/render.tsx";
import {
  invalidateIntegrationQueries,
  type IntegrationManifestView,
} from "../../../hooks/use-integrations.ts";
import { IntegrationConnectionPicker } from "../integration-connection-picker.tsx";
import {
  useConnectionPicker,
  type ConnectionPicker,
  type ConnectionPickerDeps,
  type ConnectionPickerPersistence,
} from "../use-connection-picker.ts";

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

type Persistence = Parameters<typeof IntegrationConnectionPicker>[0]["persistence"];

/** The one readiness query the picker reads, under the key it builds. */
const READINESS_KEY = $api.queryOptions("get", "/api/agents/{scope}/{name}/connection-readiness", {
  params: {
    path: { scope: "@acme", name: "ops" },
    header: { "X-Org-Id": undefined, "X-Space-Id": undefined },
  },
}).queryKey;

function readiness(res: Resolution, runBlocking = false) {
  return {
    blocks_run: runBlocking,
    errors: [],
    integrations: [
      { integration_package_id: INTEGRATION, run_blocking: runBlocking, resolution: res },
    ],
  };
}

function renderPicker(res: Resolution, runBlocking: boolean, persistence?: Persistence): string {
  const qc = new QueryClient();
  qc.setQueryData(READINESS_KEY, readiness(res, runBlocking));
  return render(
    <IntegrationConnectionPicker
      integrationId={INTEGRATION}
      agentPackageId={AGENT}
      manifest={MANIFEST}
      authStatuses={[]}
      agentTools={undefined}
      agentScopes={undefined}
      {...(persistence ? { persistence } : {})}
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
    const html = renderPicker(resolution({}), false, {
      mode: "override",
      value: [DB, GONE],
      onChange: () => {},
    });
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
    // {WEB serves, GONE does not}: the candidates hold WEB alone, but the trigger
    // counts the whole stored set, since the run is refused over GONE.
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
    // Nothing resolved: the trigger names the broken default, not a connect prompt.
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

  it("names a locked member that is no candidate as unavailable, and warns while runs are blocked", () => {
    const html = renderPicker(
      resolution({
        source: "admin_pin",
        error_code: "pinned_connection_unavailable",
        admin_pinned_connection_ids: [WEB, GONE],
      }),
      true,
    );
    expect(html).toContain(`member-pick-locked-${INTEGRATION}`);
    expect(html).not.toContain(GONE);
    expect(html).toContain(t("unavailableCount", { count: 1 }));
    expect(html).toContain(WARNING);
    expect(html).toContain("text-amber-600");
  });

  it("offers to clear an override stored under a lock, the server's only way out of it", () => {
    const locked = resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB] });
    const clear = `member-pick-clear-${INTEGRATION}`;
    const withOverride = renderPicker(locked, false, {
      mode: "override",
      value: [DB],
      onChange: () => {},
    });
    expect(withOverride).toContain(`member-pick-locked-${INTEGRATION}`);
    expect(withOverride).toContain(clear);
    expect(withOverride).toContain(i18n.t("agents:schedule.connectionOverrides.clearChoice"));
    expect(
      renderPicker(locked, false, { mode: "override", value: [], onChange: () => {} }),
    ).not.toContain(clear);
    expect(renderPicker(locked, false)).not.toContain(clear);
  });

  it("shows an override stored within the lock as what binds, with nothing to clear", () => {
    // The server accepts a subset of the locked set: it narrows the lock, it is not outranked.
    const html = renderPicker(
      resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB, DB] }),
      false,
      { mode: "override", value: [DB], onChange: () => {} },
    );
    expect(html).toContain(`member-pick-locked-${INTEGRATION}`);
    expect(html).toContain(">db<");
    expect(html).not.toContain("web · db");
    expect(html).not.toContain(`member-pick-clear-${INTEGRATION}`);
  });

  it("a soft org default leaves the dropdown open", () => {
    const html = renderPicker(
      resolution({ source: "org_default", org_default_connection_ids: [WEB] }),
      false,
    );
    expect(html).not.toContain(`member-pick-locked-${INTEGRATION}`);
    expect(html).toContain(`member-pick-${INTEGRATION}`);
  });

  it("offers neither a pick nor a connect when the agent's auth_key serves no selected tool", () => {
    const html = renderPicker(
      resolution({
        source: null,
        error_code: "auth_key_serves_no_selected_tool",
        admin_pinned_connection_ids: [WEB],
        candidates: [],
      }),
      true,
    );
    expect(html).toContain(`member-pick-reconfigure-${INTEGRATION}`);
    expect(html).toContain(t("reconfigureLabel"));
    expect(html).not.toContain(t("connectLabel"));
    expect(html).not.toContain(`member-pick-${INTEGRATION}`);
    expect(html).not.toContain(`member-pick-locked-${INTEGRATION}`);
  });
});

describe("useConnectionPicker — triggerConnect after the connect popup", () => {
  const ADDED = "44444444-4444-4444-8444-444444444444";
  type Readiness = ReturnType<typeof readiness>;
  type OpenPopup = NonNullable<ConnectionPickerDeps["openPopup"]>;

  const before = async () => readiness(resolution({}));
  const withAdded = async () =>
    readiness(
      resolution({
        candidates: [candidate(WEB, "web"), candidate(DB, "db"), candidate(ADDED, "new")],
      }),
    );

  /** The readiness query mounted as the picker holds it: active, each fetch answered in turn. */
  async function mountReadiness(qc: QueryClient, answers: Array<() => Promise<Readiness>>) {
    let asked = 0;
    const options = {
      queryKey: READINESS_KEY,
      queryFn: () => answers[asked++]!(),
      retry: false,
    };
    const observer = new QueryObserver(qc, options);
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A query refetches with the options of the observer set up last; rendering
    // the picker sets up its own, bound to the real client.
    const rebind = () => observer.setOptions(options);
    return { asked: () => asked, rebind, unsubscribe };
  }

  function Probe({
    persistence,
    openPopup,
    onPicker,
  }: {
    persistence: ConnectionPickerPersistence;
    openPopup: OpenPopup;
    onPicker: (picker: ConnectionPicker | null) => void;
  }) {
    onPicker(
      useConnectionPicker(
        {
          integrationId: INTEGRATION,
          agentPackageId: AGENT,
          manifest: MANIFEST,
          authStatuses: [],
          agentTools: undefined,
          agentScopes: undefined,
          persistence,
        },
        { openPopup },
      ),
    );
    return null;
  }

  /** An empty override, so a created connection is written straight through `onChange`. */
  async function setup(
    answers: Array<() => Promise<Readiness>>,
    popup: (qc: QueryClient) => OpenPopup,
  ) {
    const qc = new QueryClient();
    const mounted = await mountReadiness(qc, answers);
    const picked: string[][] = [];
    const pickers: Array<ConnectionPicker | null> = [];
    render(
      <Probe
        persistence={{ mode: "override", value: [], onChange: (ids) => picked.push(ids) }}
        openPopup={popup(qc)}
        onPicker={(p) => pickers.push(p)}
      />,
      { queryClient: qc },
    );
    mounted.rebind();
    const picker = pickers[0];
    if (!picker) throw new Error("the readiness verdict should be loaded");
    return { mounted, picked, picker };
  }

  /** The real popup's contract: `true` once the active integration queries were refetched. */
  const settles =
    (qc: QueryClient): OpenPopup =>
    async () => {
      await invalidateIntegrationQueries(qc);
      return true;
    };

  it("writes the created connection, read off the one refetch the popup awaited", async () => {
    const { mounted, picked, picker } = await setup([before, withAdded], settles);
    await picker.triggerConnect("primary");
    expect(picked).toEqual([[ADDED]]);
    // The mount, then the popup's refetch: reading after it asks nothing more.
    expect(mounted.asked()).toBe(2);
    mounted.unsubscribe();
  });

  it("toasts a failed refetch instead of rejecting or passing the stale verdict off", async () => {
    const toasted = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      const failure = new ApiError("internal_error", "boom", 500);
      const { mounted, picked, picker } = await setup(
        [before, () => Promise.reject(failure)],
        settles,
      );
      await expect(picker.triggerConnect("primary")).resolves.toBeUndefined();
      expect(toasted).toHaveBeenCalledTimes(1);
      expect(picked).toEqual([]);
      mounted.unsubscribe();
    } finally {
      toasted.mockRestore();
    }
  });

  it("reads nothing when the popup did not settle", async () => {
    const toasted = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      const { mounted, picked, picker } = await setup([before], (qc) => async () => {
        // A refetch landed meanwhile (window focus): the cache already holds a new row.
        qc.setQueryData(READINESS_KEY, await withAdded());
        return false;
      });
      await picker.triggerConnect("primary");
      expect(picked).toEqual([]);
      expect(toasted).not.toHaveBeenCalled();
      expect(mounted.asked()).toBe(1);
      mounted.unsubscribe();
    } finally {
      toasted.mockRestore();
    }
  });
});
