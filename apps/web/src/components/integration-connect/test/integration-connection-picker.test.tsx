// SPDX-License-Identifier: Apache-2.0

/**
 * The picker when a member of the stored set is unusable — gone (deleted or
 * unshared by its owner), or on an auth serving none of the selected tools. The
 * server keeps refusing the set — it never binds what is left — so the picker
 * must say so, instead of showing the survivors as if they were the whole
 * selection. Plus how the picker reads the connection a connect popup created,
 * and "no connection" (`[]`) — distinct from no pick (`null`), offered only for
 * an integration the agent does not require.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { $api, client, type components } from "../../../api/client.ts";
import { ApiError } from "../../../api/errors.ts";
import i18n, { i18nReady } from "../../../i18n.ts";
import { installFakeStorage } from "../../../test/fake-storage.ts";
import { render } from "../../../test/render.tsx";
import {
  invalidateIntegrationQueries,
  type IntegrationAuthStatus,
  type IntegrationManifestView,
} from "../../../hooks/use-integrations.ts";
import { ConfirmModal } from "../../confirm-modal.tsx";
import { IntegrationConnectionPicker } from "../integration-connection-picker.tsx";
import { PickerMenu } from "../connection-picker-menu.tsx";
import {
  ConnectionChoiceMenu,
  type ConnectionChoiceMenuProps,
} from "../connection-choice-menu.tsx";
import { UnderScopedWarning } from "../connection-picker-states.tsx";
import { ScopeSummaryText } from "../scope-summary-text.tsx";
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
    scope: "org",
    spaceId: null,
    shared_here: false,
    shared_space_ids: [],
    origin_space_id: null,
    needs_reconnection: false,
    missing_scopes: [],
    scope_fit: "unjudged",
    is_own: true,
  };
}

function resolution(overrides: Partial<Resolution>): Resolution {
  return {
    source: "member_pin",
    error_code: null,
    warning: null,
    resolved_connection_ids: [],
    resolved_missing_scopes: [],
    admin_pinned_connection_ids: null,
    member_pinned_connection_ids: null,
    org_default_connection_ids: null,
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

function readiness(res: Resolution, runBlocking = false, required = false) {
  return {
    blocks_run: runBlocking,
    errors: [],
    integrations: [
      {
        integration_package_id: INTEGRATION,
        required,
        run_blocking: runBlocking,
        inert: false,
        resolution: res,
      },
    ],
  };
}

function renderPicker(
  res: Resolution,
  runBlocking: boolean,
  persistence?: Persistence,
  required = false,
): string {
  const qc = new QueryClient();
  qc.setQueryData(READINESS_KEY, readiness(res, runBlocking, required));
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
    expect(html).toContain("text-warning");
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

  it("reads a fallback-bound connection as what the trigger inherits", () => {
    const html = renderPicker(
      resolution({ source: "fallback_auto", resolved_connection_ids: [WEB] }),
      false,
    );
    expect(html).toContain(t("inheritTrigger", { name: "web" }));
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
    expect(html).toContain("text-warning");
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
    expect(withOverride).toContain(i18n.t("agents:connectionOverrides.clearChoice"));
    expect(
      renderPicker(locked, false, { mode: "override", value: null, onChange: () => {} }),
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

  it("judges an override narrowing a lock on what it binds, not on the locked set", () => {
    // The admin pin holds a dead member, so the cascade blocks; the override binds `db` alone.
    const deadWeb = { ...candidate(WEB, "web"), needs_reconnection: true };
    const locked = resolution({
      source: "admin_pin",
      admin_pinned_connection_ids: [WEB, DB],
      candidates: [deadWeb, candidate(DB, "db")],
    });
    const override = (value: string[] | null): Persistence => ({
      mode: "override",
      value,
      onChange: () => {},
    });
    const narrowed = renderPicker(locked, true, override([DB]));
    expect(narrowed).toContain(`member-pick-locked-${INTEGRATION}`);
    expect(narrowed).toContain(">db<");
    expect(narrowed).not.toContain("text-warning");
    // Control: unset, the locked set binds, and narrowed to the dead member it still gates.
    expect(renderPicker(locked, true, override(null))).toContain("text-warning");
    expect(renderPicker(locked, true, override([WEB]))).toContain("text-warning");
    // "No connection" under a healthy lock gates only an integration the agent requires.
    const healthy = resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB, DB] });
    expect(renderPicker(healthy, false, override([]), true)).toContain("text-warning");
    expect(renderPicker(healthy, false, override([]))).not.toContain("text-warning");
  });

  it("says why an override reaching outside the lock is refused, whatever the cascade binds", () => {
    const outranked = `member-pick-outranked-warning-${INTEGRATION}`;
    const locked = resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB] });
    const html = renderPicker(locked, false, {
      mode: "override",
      value: [DB],
      onChange: () => {},
    });
    expect(html).toContain("text-warning");
    expect(html).toContain(outranked);
    expect(html).toContain(i18n.t("agents:error.overrideOutranked"));
    expect(html).toContain(`member-pick-clear-${INTEGRATION}`);
    // Control: an override within the lock is not refused.
    const within = renderPicker(locked, false, {
      mode: "override",
      value: [WEB],
      onChange: () => {},
    });
    expect(within).not.toContain(outranked);
    expect(within).not.toContain("text-warning");
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

const NO_STATUSES: IntegrationAuthStatus[] = [];

function PickerProbe({
  persistence,
  version,
  manifest = MANIFEST,
  authStatuses = NO_STATUSES,
  agentTools,
  agentScopes,
  openPopup,
  onPicker,
}: {
  persistence: ConnectionPickerPersistence;
  version?: string;
  manifest?: IntegrationManifestView;
  authStatuses?: IntegrationAuthStatus[];
  agentTools?: string[] | "*";
  agentScopes?: string[];
  openPopup?: ConnectionPickerDeps["openPopup"];
  onPicker: (picker: ConnectionPicker | null) => void;
}) {
  onPicker(
    useConnectionPicker(
      {
        integrationId: INTEGRATION,
        agentPackageId: AGENT,
        manifest,
        authStatuses,
        agentTools,
        agentScopes,
        persistence,
        version,
      },
      openPopup ? { openPopup } : {},
    ),
  );
  return null;
}

/** The menu's element tree for a picker — its content is a portal a static render drops. */
function MenuProbe({
  picker,
  onTree,
}: {
  picker: ConnectionPicker;
  onTree: (tree: ReactNode) => void;
}) {
  // The picker feeds the one choice menu: its tree is that menu's, read through the adapter.
  const adapter = PickerMenu({
    integrationId: INTEGRATION,
    picker,
  }) as ReactElement<ConnectionChoiceMenuProps>;
  onTree(ConnectionChoiceMenu(adapter.props));
  return null;
}

/** The under-scoped warning's element tree, its hooks run by this probe. */
function WarningProbe({
  conn,
  picker,
  onTree,
}: {
  conn: Candidate;
  picker: ConnectionPicker;
  onTree: (tree: ReactNode) => void;
}) {
  onTree(UnderScopedWarning({ conn, picker }));
  return null;
}

/** The props of the element carrying `testId`, found in an element tree. */
function propsOf(node: ReactNode, testId: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child, testId);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (node.props["data-testid"] === testId) return node.props;
  return propsOf(node.props.children as ReactNode, testId);
}

/**
 * The picker's state for a verdict, as the hook computes it — after `tick`, when given, was
 * toggled as an uncommitted draft.
 */
function pickerFor(
  res: Resolution,
  opts: { required?: boolean; persistence?: Persistence; tick?: string } = {},
): ConnectionPicker {
  const qc = new QueryClient();
  qc.setQueryData(READINESS_KEY, readiness(res, false, opts.required ?? false));
  const pickers: Array<ConnectionPicker | null> = [];
  render(
    <PickerProbe
      persistence={opts.persistence ?? { mode: "pin" }}
      onPicker={(p) => {
        pickers.push(p);
        // A state update during the probe's own render: React renders it again with the draft.
        if (opts.tick !== undefined && pickers.length === 1) p?.toggle(opts.tick);
      }}
    />,
    { queryClient: qc },
  );
  const picker = pickers[pickers.length - 1];
  if (!picker) throw new Error("the readiness verdict should be loaded");
  return picker;
}

/** The menu's element tree for a picker. */
function menuOf(picker: ConnectionPicker): ReactNode {
  const trees: ReactNode[] = [];
  render(<MenuProbe picker={picker} onTree={(tree) => trees.push(tree)} />);
  return trees[0];
}

/** Every string rendered literally in an element tree. */
function textsOf(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(textsOf);
  if (!isValidElement<{ children?: unknown }>(node)) return [];
  return textsOf(node.props.children);
}

describe("IntegrationConnectionPicker — 'no connection'", () => {
  const t = (key: string, opts?: Record<string, unknown>) =>
    i18n.t(`agents:detail.integrationMemberPicker.${key}`, opts);

  it("surfaces the agent's `required` flag, which withholds 'no connection'", () => {
    const unbound = resolution({ source: null, resolved_connection_ids: [] });
    expect(pickerFor(unbound).required).toBe(false);
    expect(pickerFor(unbound, { required: true }).required).toBe(true);
  });

  it("reads `required` off the version it is given, not the default one", () => {
    // The draft drops the requirement the published version (the one a plain launch runs) keeps.
    const unbound = resolution({ source: null, resolved_connection_ids: [] });
    const qc = new QueryClient();
    qc.setQueryData(READINESS_KEY, readiness(unbound, false, false));
    const publishedKey = $api.queryOptions(
      "get",
      "/api/agents/{scope}/{name}/connection-readiness",
      {
        params: {
          path: { scope: "@acme", name: "ops" },
          query: { version: "published" },
          header: { "X-Org-Id": undefined, "X-Space-Id": undefined },
        },
      },
    ).queryKey;
    qc.setQueryData(publishedKey, readiness(unbound, false, true));
    const required = (version?: string) => {
      const pickers: Array<ConnectionPicker | null> = [];
      render(
        <PickerProbe
          persistence={{ mode: "override", value: null, onChange: () => {} }}
          version={version}
          onPicker={(p) => pickers.push(p)}
        />,
        { queryClient: qc },
      );
      return pickers[0]?.required;
    };
    expect(required("published")).toBe(true);
    expect(required()).toBe(false);
  });

  it("offers to connect only the agent's auth when the actor's connections are on another", () => {
    const twoAuths = {
      auths: { primary: { type: "custom" }, token: { type: "api_key" } },
    } as unknown as IntegrationManifestView;
    const authKeysFor = (res: Resolution) => {
      const qc = new QueryClient();
      qc.setQueryData(READINESS_KEY, readiness(res));
      const pickers: Array<ConnectionPicker | null> = [];
      render(
        <PickerProbe
          persistence={{ mode: "pin" }}
          manifest={twoAuths}
          onPicker={(p) => pickers.push(p)}
        />,
        { queryClient: qc },
      );
      return pickers[0]?.authKeys;
    };
    const unbound = { source: null, resolved_connection_ids: [], candidates: [] };
    const field = `integrations.${INTEGRATION}`;
    const otherAuth = resolution({
      ...unbound,
      warning: {
        field,
        code: "auth_key_mismatch",
        message: "other auth",
        required_auth_key: "primary",
        available_auth_keys: ["token"],
      },
    });
    expect(authKeysFor(otherAuth)).toEqual(["primary"]);
    const notConnected = resolution({
      ...unbound,
      warning: { field, code: "not_connected", message: "not connected" },
    });
    expect(authKeysFor(notConnected)).toEqual(["primary", "token"]);
  });

  it("persists [] for 'no connection' and null for an unset pick, as two different overrides", async () => {
    const written: Array<string[] | null> = [];
    const picker = pickerFor(resolution({}), {
      persistence: { mode: "override", value: [WEB], onChange: (ids) => written.push(ids) },
    });
    await picker.persist([]);
    await picker.persist(null);
    expect(written).toEqual([[], null]);
  });

  it("shows a stored 'no connection' as such, ticking nothing, and never the cascade", () => {
    const res = resolution({
      source: null,
      member_pinned_connection_ids: [],
      resolved_connection_ids: [],
    });
    const picker = pickerFor(res);
    expect(picker.pickedNone).toBe(true);
    expect(picker.checkedIds).toEqual([]);
    expect(renderPicker(res, false)).toContain(t("none"));
    // Control: no pin at all is not "no connection" — the trigger asks to connect.
    const unpinned = renderPicker(resolution({ source: null, resolved_connection_ids: [] }), false);
    expect(unpinned).not.toContain(t("none"));
    expect(unpinned).toContain(t("connectLabel"));
  });

  it("an override of 'no connection' shows itself: the trigger never shows the cascade's set", () => {
    const fallback = resolution({ source: "fallback_auto", resolved_connection_ids: [WEB] });
    const none: Persistence = { mode: "override", value: [], onChange: () => {} };
    const html = renderPicker(fallback, false, none);
    expect(html).toContain(t("none"));
    expect(html).not.toContain(">web<");
    expect(html).not.toContain(t("defaultBadge"));
  });

  it("warns on a stored 'no connection' override for an integration the agent requires", () => {
    const none: Persistence = { mode: "override", value: [], onChange: () => {} };
    const html = renderPicker(resolution({}), false, none, true);
    expect(html).toContain(t("none"));
    expect(html).toContain("text-warning");
    // Control: the same override on an integration the agent does not require is a choice.
    expect(renderPicker(resolution({}), false, none)).not.toContain("text-warning");
  });

  it("an admin pin to none locks the picker on 'no connection'", () => {
    const html = renderPicker(
      resolution({ source: null, admin_pinned_connection_ids: [], resolved_connection_ids: [] }),
      false,
    );
    expect(html).toContain(`member-pick-locked-${INTEGRATION}`);
    expect(html).toContain(t("none"));
  });

  it("under a lock, a stored 'no connection' override binds none and can be cleared", () => {
    const html = renderPicker(
      resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB] }),
      false,
      { mode: "override", value: [], onChange: () => {} },
    );
    expect(html).toContain(`member-pick-locked-${INTEGRATION}`);
    expect(html).toContain(t("none"));
    expect(html).not.toContain(">web<");
    expect(html).toContain(`member-pick-clear-${INTEGRATION}`);
  });

  it("an enforced org default offers no 'no connection' to pick: the picker is locked", () => {
    const html = renderPicker(
      resolution({
        source: "org_default_enforced",
        org_default_connection_ids: [WEB],
        org_default_enforced: true,
        resolved_connection_ids: [WEB],
      }),
      false,
    );
    expect(html).toContain(`member-pick-locked-${INTEGRATION}`);
    expect(html).not.toContain(`member-pick-none-${INTEGRATION}`);
    expect(html).not.toContain(t("none"));
  });

  // `[]` is a subset of any lock, so a launch override may narrow it to none.
  it("under a lock, offers a 'no connection' override for an integration the agent does not require", () => {
    const none = `member-pick-none-${INTEGRATION}`;
    const unset: Persistence = { mode: "override", value: null, onChange: () => {} };
    const pinned = resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB] });
    const enforced = resolution({
      source: "org_default_enforced",
      org_default_connection_ids: [WEB],
      org_default_enforced: true,
      resolved_connection_ids: [WEB],
    });
    for (const locked of [pinned, enforced]) {
      const html = renderPicker(locked, false, unset);
      expect(html).toContain(`member-pick-locked-${INTEGRATION}`);
      expect(html).toContain(none);
      // Never for a required integration, nor on a member pin (it loses to the lock anyway).
      expect(renderPicker(locked, false, unset, true)).not.toContain(none);
      expect(renderPicker(locked, false)).not.toContain(none);
    }
    // Already none: through the stored override, or the admin's own pin to none.
    expect(
      renderPicker(pinned, false, { mode: "override", value: [], onChange: () => {} }),
    ).not.toContain(none);
    expect(
      renderPicker(
        resolution({ source: null, admin_pinned_connection_ids: [], resolved_connection_ids: [] }),
        false,
        unset,
      ),
    ).not.toContain(none);
  });

  it("reads out the three modes as radios, and the connections under « Choisir » as boxes", () => {
    const tree = (res: Resolution) => menuOf(pickerFor(res));
    const none = tree(resolution({ source: null, member_pinned_connection_ids: [] }));
    expect(propsOf(none, `member-pick-none-${INTEGRATION}`)).toMatchObject({
      role: "menuitemradio",
      "aria-checked": true,
    });
    expect(propsOf(none, `member-pick-reset-${INTEGRATION}`)).toMatchObject({
      role: "menuitemradio",
      "aria-checked": false,
    });
    expect(propsOf(none, `member-pick-choose-${INTEGRATION}`)).toMatchObject({
      role: "menuitemradio",
      "aria-checked": false,
    });
    expect(propsOf(none, `member-pick-option-${WEB}`)).toMatchObject({
      role: "menuitemcheckbox",
      "aria-checked": false,
    });
    // One connection to pick from is still a box, never a radio of its own.
    const single = tree(
      resolution({
        candidates: [candidate(WEB, "web")],
        source: null,
        member_pinned_connection_ids: [WEB],
      }),
    );
    expect(propsOf(single, `member-pick-option-${WEB}`)).toMatchObject({
      role: "menuitemcheckbox",
      "aria-checked": true,
    });
    expect(propsOf(single, `member-pick-choose-${INTEGRATION}`)).toMatchObject({
      "aria-checked": true,
    });
    expect(propsOf(single, `member-pick-reset-${INTEGRATION}`)).toMatchObject({
      "aria-checked": false,
    });
  });

  it("withholds « Aucune connexion » for a required integration, keeping the other two modes", () => {
    const tree = (required: boolean) => {
      const trees: ReactNode[] = [];
      render(
        <MenuProbe
          picker={pickerFor(resolution({ source: null }), { required })}
          onTree={(tree) => trees.push(tree)}
        />,
      );
      return trees[0];
    };
    expect(propsOf(tree(false), `member-pick-none-${INTEGRATION}`)).toBeDefined();
    const required = tree(true);
    expect(propsOf(required, `member-pick-none-${INTEGRATION}`)).toBeUndefined();
    expect(propsOf(required, `member-pick-reset-${INTEGRATION}`)).toBeDefined();
    expect(propsOf(required, `member-pick-choose-${INTEGRATION}`)).toBeDefined();
  });

  it("offers nothing to pick before the readiness entry, and so `required`, is known", () => {
    const pickers: Array<ConnectionPicker | null> = [];
    const html = render(
      <PickerProbe persistence={{ mode: "pin" }} onPicker={(p) => pickers.push(p)} />,
      { queryClient: new QueryClient() },
    );
    expect(html).toBe("");
    expect(pickers).toEqual([null]);
    const loading = render(
      <IntegrationConnectionPicker
        integrationId={INTEGRATION}
        agentPackageId={AGENT}
        manifest={MANIFEST}
        authStatuses={[]}
        agentTools={undefined}
        agentScopes={undefined}
      />,
      { queryClient: new QueryClient() },
    );
    expect(loading).toContain(`member-picker-${INTEGRATION}`);
    expect(loading).not.toContain(`member-pick-none-${INTEGRATION}`);
  });
});

describe("PickerMenu — where a candidate comes from", () => {
  const ORIGIN = "spc_origin";

  /** The text of an element tree, without rendering it (its items need the menu's context). */
  function textOf(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (!isValidElement<{ children?: ReactNode }>(node)) return "";
    return textOf(node.props.children);
  }

  function rowText(c: Candidate): string {
    const qc = new QueryClient();
    qc.setQueryData(READINESS_KEY, readiness(resolution({ candidates: [c] })));
    // The current org's space listing, under the key `useSpaces` reads.
    const spacesKey = $api.queryOptions("get", "/api/spaces", {
      params: { header: { "X-Org-Id": undefined } },
    }).queryKey;
    qc.setQueryData(spacesKey, {
      object: "list",
      data: [{ id: ORIGIN, name: "Marketing", access: "member", personal: false }],
      hasMore: false,
    });
    const pickers: Array<ConnectionPicker | null> = [];
    render(<PickerProbe persistence={{ mode: "pin" }} onPicker={(p) => pickers.push(p)} />, {
      queryClient: qc,
    });
    const trees: ReactNode[] = [];
    render(<MenuProbe picker={pickers[0]!} onTree={(tree) => trees.push(tree)} />, {
      queryClient: qc,
    });
    const row = propsOf(trees[0], `member-pick-option-${c.id}`);
    if (!row) throw new Error("the candidate should be listed");
    return textOf(row.children as ReactNode);
  }

  const t = (key: string, opts?: Record<string, unknown>) =>
    i18n.t(`agents:detail.integrationMemberPicker.${key}`, opts);
  // The origin reads after the connection's type: « Clé API · connectée depuis Default ».
  const inline = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

  it("tells the owner of an org-scoped row the space it was connected from", () => {
    const own = { ...candidate(WEB, "web"), origin_space_id: ORIGIN };
    expect(rowText(own)).toContain(inline(t("connectedFrom", { space: "Marketing" })));
  });

  it("names the owner to anyone else, and on a space-scoped row", () => {
    const foreign = { ...candidate(WEB, "web"), is_own: false, owner_name: "Alice" };
    expect(rowText(foreign)).toContain(inline(t("connectedBy", { owner: "Alice" })));
    const spaceScoped = { ...candidate(WEB, "web"), scope: "space" as const, spaceId: ORIGIN };
    expect(rowText(spaceScoped)).toContain(inline(t("connectedBy", { owner: t("byYou") })));
  });

  it("falls back to the owner when the origin space is gone", () => {
    expect(rowText(candidate(WEB, "web"))).toContain(
      inline(t("connectedBy", { owner: t("byYou") })),
    );
  });
});

describe("useConnectionPicker — triggerConnect after the connect popup", () => {
  const ADDED = "44444444-4444-4444-8444-444444444444";
  type Readiness = ReturnType<typeof readiness>;
  type OpenPopup = NonNullable<ConnectionPickerDeps["openPopup"]>;

  const answer = (res: Partial<Resolution>) => async () => readiness(resolution(res));
  const before = answer({});
  const ALL = [candidate(WEB, "web"), candidate(DB, "db"), candidate(ADDED, "new")];
  const withAdded = answer({ candidates: ALL });
  // The fallback binds `web` alone; with a second connection to choose from it binds nothing.
  const fallbackBefore = answer({ source: "fallback_auto", resolved_connection_ids: [WEB] });
  const fallbackAfter = answer({
    source: null,
    error_code: "must_choose_connection",
    candidates: ALL,
  });

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

  async function mount(
    answers: Array<() => Promise<Readiness>>,
    popup: (qc: QueryClient) => OpenPopup,
    persistence: ConnectionPickerPersistence,
  ) {
    const qc = new QueryClient();
    const mounted = await mountReadiness(qc, answers);
    const pickers: Array<ConnectionPicker | null> = [];
    render(
      <PickerProbe
        persistence={persistence}
        openPopup={popup(qc)}
        onPicker={(p) => pickers.push(p)}
      />,
      { queryClient: qc },
    );
    mounted.rebind();
    const picker = pickers[0];
    if (!picker) throw new Error("the readiness verdict should be loaded");
    return { mounted, picker };
  }

  /** Override mode: the written set is what `onChange` receives. */
  async function setup(
    answers: Array<() => Promise<Readiness>>,
    popup: (qc: QueryClient) => OpenPopup,
    stored: string[] | null = null,
  ) {
    const picked: Array<string[] | null> = [];
    const onChange = (ids: string[] | null) => picked.push(ids);
    const persistence = { mode: "override" as const, value: stored, onChange };
    return { ...(await mount(answers, popup, persistence)), picked };
  }

  /** The real popup's contract: `true` once the active integration queries were refetched. */
  const settles =
    (qc: QueryClient): OpenPopup =>
    async () => {
      await invalidateIntegrationQueries(qc);
      return true;
    };

  it("adds the created connection to the set the fallback bound, read off the one refetch the popup awaited", async () => {
    const { mounted, picked, picker } = await setup([fallbackBefore, fallbackAfter], settles);
    await picker.triggerConnect("primary");
    expect(picked).toEqual([[WEB, ADDED]]);
    // The mount, then the popup's refetch: reading after it asks nothing more.
    expect(mounted.asked()).toBe(2);
    mounted.unsubscribe();
  });

  it("writes the fallback's set with the created connection as the member's pin", async () => {
    const put = spyOn(client, "PUT").mockResolvedValue({ data: {} });
    try {
      const { mounted, picker } = await mount(
        [fallbackBefore, fallbackAfter, fallbackAfter],
        settles,
        { mode: "pin" },
      );
      await picker.triggerConnect("primary");
      const calls = put.mock.calls as unknown as Array<[string, { body: unknown }]>;
      expect(calls.map(([path, init]) => [path, init.body])).toEqual([
        [
          "/api/me/integration-pins/{agentPackageId}/integrations/{integrationPackageId}",
          { connection_ids: [WEB, ADDED] },
        ],
      ]);
      // The pin write moved the verdict: it is read again.
      expect(mounted.asked()).toBe(3);
      mounted.unsubscribe();
    } finally {
      put.mockRestore();
    }
  });

  it("adds the created connection to a stored pick", async () => {
    const { mounted, picked, picker } = await setup([before, withAdded], settles, [WEB]);
    await picker.triggerConnect("primary");
    expect(picked).toEqual([[WEB, ADDED]]);
    mounted.unsubscribe();
  });

  it("adds the created connection to the member's pin an unset override shows, kept to its candidates", async () => {
    // The pin names a member that is no candidate: the server binds none of it.
    const brokenPin = {
      error_code: "pinned_connection_unavailable" as const,
      member_pinned_connection_ids: [WEB, GONE],
    };
    const { mounted, picked, picker } = await setup(
      [answer(brokenPin), answer({ ...brokenPin, candidates: ALL })],
      settles,
    );
    await picker.triggerConnect("primary");
    expect(picked).toEqual([[WEB, ADDED]]);
    mounted.unsubscribe();
  });

  it("replaces a stored 'no connection' with the created connection, never the cascade's set", async () => {
    const { mounted, picked, picker } = await setup([fallbackBefore, fallbackAfter], settles, []);
    await picker.triggerConnect("primary");
    expect(picked).toEqual([[ADDED]]);
    mounted.unsubscribe();
  });

  it("swaps a connection created to replace a stored member for it, written at once", async () => {
    const { mounted, picked, picker } = await setup([before, withAdded], settles, [WEB, DB]);
    await picker.triggerConnect("primary", { replacing: WEB });
    expect(picked).toEqual([[ADDED, DB]]);
    mounted.unsubscribe();
  });

  it("leaves out a stored member the refetch offers no more", async () => {
    const dbGone = answer({ candidates: [candidate(WEB, "web"), candidate(ADDED, "new")] });
    const { mounted, picked, picker } = await setup([before, dbGone], settles, [WEB, DB]);
    await picker.triggerConnect("primary");
    expect(picked).toEqual([[WEB, ADDED]]);
    mounted.unsubscribe();
  });

  it("writes nothing at the cap and says so", async () => {
    const warned = spyOn(toast, "warning").mockImplementation(() => 0);
    try {
      const full = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION }, (_, i) =>
        candidate(`c${i}`, `c${i}`),
      );
      const fullIds = full.map((c) => c.id);
      const { mounted, picked, picker } = await setup(
        [answer({ candidates: full }), answer({ candidates: [...full, candidate(ADDED, "new")] })],
        settles,
        fullIds,
      );
      await picker.triggerConnect("primary");
      expect(picked).toEqual([]);
      expect(warned.mock.calls as unknown[][]).toEqual([
        [
          i18n.t("agents:detail.integrationMemberPicker.maxReached", {
            max: MAX_CONNECTIONS_PER_INTEGRATION,
          }),
        ],
      ]);
      mounted.unsubscribe();
    } finally {
      warned.mockRestore();
    }
  });

  it("swaps at the cap: the replaced member frees the place", async () => {
    const full = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION }, (_, i) =>
      candidate(`c${i}`, `c${i}`),
    );
    const fullIds = full.map((c) => c.id);
    const { mounted, picked, picker } = await setup(
      [answer({ candidates: full }), answer({ candidates: [...full, candidate(ADDED, "new")] })],
      settles,
      fullIds,
    );
    await picker.triggerConnect("primary", { replacing: "c0" });
    expect(picked).toEqual([[ADDED, ...fullIds.slice(1)]]);
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

  it("reports a refused pin write, and reads no verdict it did not move", async () => {
    const put = spyOn(client, "PUT").mockRejectedValue(new ApiError("forbidden", "no", 403));
    try {
      const { mounted, picker } = await mount([before], settles, { mode: "pin" });
      expect(await picker.persist([WEB])).toBe(false);
      expect(put).toHaveBeenCalledTimes(1);
      expect(mounted.asked()).toBe(1);
      mounted.unsubscribe();
    } finally {
      put.mockRestore();
    }
  });

  it("a connect whose pin write is refused settles without a second write or read", async () => {
    const warned = spyOn(toast, "warning").mockImplementation(() => 0);
    const put = spyOn(client, "PUT").mockRejectedValue(new ApiError("forbidden", "no", 403));
    try {
      const { mounted, picker } = await mount([fallbackBefore, fallbackAfter], settles, {
        mode: "pin",
      });
      await expect(picker.triggerConnect("primary")).resolves.toBeUndefined();
      const calls = put.mock.calls as unknown as Array<[string, { body: unknown }]>;
      expect(calls.map(([, init]) => init.body)).toEqual([{ connection_ids: [WEB, ADDED] }]);
      // The mount, then the popup's refetch: the refused write moved no verdict.
      expect(mounted.asked()).toBe(2);
      expect(warned).not.toHaveBeenCalled();
      mounted.unsubscribe();
    } finally {
      warned.mockRestore();
      put.mockRestore();
    }
  });

  it("the menu closes on an accepted set and stays open on a refused one", async () => {
    const closes = async (accepted: boolean) => {
      const opened: boolean[] = [];
      const picker = {
        ...pickerFor(resolution({}), { tick: WEB }),
        persist: async () => accepted,
        onOpenChange: (open: boolean) => opened.push(open),
      };
      const apply = propsOf(menuOf(picker), `member-pick-apply-${INTEGRATION}`);
      (apply!.onSelect as (e: { preventDefault: () => void }) => void)({ preventDefault() {} });
      await Bun.sleep(0);
      return opened;
    };
    expect(await closes(true)).toEqual([false]);
    expect(await closes(false)).toEqual([]);
  });

  it("writes nothing and says nothing when the settled popup created no connection", async () => {
    const failed = spyOn(toast, "error").mockImplementation(() => 0);
    const warned = spyOn(toast, "warning").mockImplementation(() => 0);
    const put = spyOn(client, "PUT").mockResolvedValue({ data: {} });
    try {
      // The refetch the popup awaited offers the same candidates as before it.
      const override = await setup([fallbackBefore, fallbackBefore], settles);
      await override.picker.triggerConnect("primary");
      expect(override.picked).toEqual([]);
      expect(override.mounted.asked()).toBe(2);
      override.mounted.unsubscribe();
      const pin = await mount([fallbackBefore, fallbackBefore], settles, { mode: "pin" });
      await pin.picker.triggerConnect("primary");
      expect(put).not.toHaveBeenCalled();
      expect(pin.mounted.asked()).toBe(2);
      pin.mounted.unsubscribe();
      expect(failed).not.toHaveBeenCalled();
      expect(warned).not.toHaveBeenCalled();
    } finally {
      failed.mockRestore();
      warned.mockRestore();
      put.mockRestore();
    }
  });
});

describe("IntegrationConnectionPicker — scopes against the agent", () => {
  const OAUTH = {
    auths: {
      primary: {
        type: "oauth2",
        default_scopes: ["read"],
        scope_catalog: [
          { value: "read", label: "Read" },
          { value: "send", label: "Send" },
          { value: "labels", label: "Labels" },
        ],
      },
    },
  } as unknown as IntegrationManifestView;
  // A usable OAuth client: the agent's auth is connectable, so a new connection is offered.
  const CONNECTABLE: IntegrationAuthStatus[] = [
    {
      auth_key: "primary",
      type: "oauth2",
      required: true,
      scopes: [],
      resource: null,
      connections: [],
      ready: true,
      has_oauth_client: true,
      has_system_client: false,
      client_auto_provisioned: false,
    },
  ];
  const LABELS = "44444444-4444-4444-8444-444444444444";
  /** A candidate as the server judged it: its grant, what it misses and its fit. */
  const scoped = (
    id: string,
    granted: string[],
    missing: string[] = [],
    verdict: Partial<Pick<Candidate, "scope_fit">> = {},
  ): Candidate => ({
    ...candidate(id, id),
    scopes_granted: granted,
    missing_scopes: missing,
    scope_fit: missing.length > 0 ? "missing" : "exact",
    ...verdict,
  });
  type OpenPopup = NonNullable<ConnectionPickerDeps["openPopup"]>;

  function pickerOver(
    candidates: Candidate[],
    opts: {
      canAdd?: boolean;
      manifest?: IntegrationManifestView;
      agentTools?: string[] | "*";
      agentScopes?: string[];
      openPopup?: OpenPopup;
    } = {},
  ): ConnectionPicker {
    const qc = new QueryClient();
    qc.setQueryData(
      READINESS_KEY,
      readiness(resolution({ candidates, can_add_connection: opts.canAdd ?? true })),
    );
    const pickers: Array<ConnectionPicker | null> = [];
    render(
      <PickerProbe
        persistence={{ mode: "pin" }}
        manifest={opts.manifest ?? OAUTH}
        authStatuses={CONNECTABLE}
        agentTools={opts.agentTools}
        agentScopes={opts.agentScopes}
        openPopup={opts.openPopup}
        onPicker={(p) => pickers.push(p)}
      />,
      { queryClient: qc },
    );
    const picker = pickers[0];
    if (!picker) throw new Error("the readiness verdict should be loaded");
    return picker;
  }

  /** The warning's element tree — its modal is a portal a static render drops. */
  function warningTree(conn: Candidate, picker: ConnectionPicker): ReactNode {
    const trees: ReactNode[] = [];
    render(<WarningProbe conn={conn} picker={picker} onTree={(tree) => trees.push(tree)} />);
    return trees[0];
  }

  function confirmModalProps(node: ReactNode): Record<string, unknown> | undefined {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = confirmModalProps(child);
        if (found) return found;
      }
      return undefined;
    }
    if (!isValidElement<Record<string, unknown>>(node)) return undefined;
    if (node.type === ConfirmModal) return node.props;
    return confirmModalProps(node.props.children as ReactNode);
  }

  // `integrations:connect` comes from the org store, absent here; it is granted by hand
  // wherever the test is about something else.
  const withConnect = (picker: ConnectionPicker): ConnectionPicker => ({
    ...picker,
    canConnect: true,
  });

  it("lists the connections in the order the server ranked them", () => {
    const picker = pickerOver([
      scoped(DB, ["read"]),
      scoped(LABELS, ["read", "labels"], [], { scope_fit: "broader" }),
      scoped(WEB, ["read"], ["send"]),
    ]);
    expect(picker.candidates.map((c) => c.id)).toEqual([DB, LABELS, WEB]);
  });

  it("offers a new connection with the agent's scopes first, the in-place upgrade second", () => {
    const conn = scoped(WEB, ["read"], ["send"]);
    const html = render(
      <UnderScopedWarning conn={conn} picker={withConnect(pickerOver([conn]))} />,
    );
    const create = html.indexOf(`member-pick-new-for-agent-${WEB}`);
    const upgrade = html.indexOf(`member-pick-upgrade-${WEB}`);
    expect(create).toBeGreaterThan(-1);
    expect(upgrade).toBeGreaterThan(create);
    expect(html).toContain(
      i18n.t("agents:detail.integrationMemberPicker.missingScopes", { scopes: "Send" }),
    );
  });

  it("a new connection from the warning takes the under-scoped one's place", () => {
    const conn = scoped(WEB, ["read"], ["send"]);
    const connected: unknown[][] = [];
    const picker: ConnectionPicker = {
      ...pickerOver([conn]),
      triggerConnect: async (...args) => {
        connected.push(args);
      },
    };
    (
      propsOf(warningTree(conn, picker), `member-pick-new-for-agent-${WEB}`)?.onClick as () => void
    )();
    expect(connected).toEqual([["primary", { replacing: WEB }]]);
  });

  it("names creating a connection as a way out only when the actor may create one", () => {
    const conn = { ...scoped(WEB, ["read"], ["send"]), is_own: false };
    const t = (key: string) =>
      i18n.t(`agents:detail.integrationMemberPicker.${key}`, { owner: "Moi" });
    const allowed = render(
      <UnderScopedWarning conn={conn} picker={withConnect(pickerOver([conn]))} />,
    );
    expect(allowed).toContain(t("missingScopesForeignCanCreate"));
    expect(allowed).toContain(`member-pick-new-for-agent-${WEB}`);
    expect(allowed).not.toContain(`member-pick-upgrade-${WEB}`);
    const blocked = render(
      <UnderScopedWarning
        conn={conn}
        picker={withConnect(pickerOver([conn], { canAdd: false }))}
      />,
    );
    expect(blocked).toContain(t("missingScopesForeign"));
    expect(blocked).not.toContain(`member-pick-new-for-agent-${WEB}`);
  });

  it("'Mettre à niveau' asks for a confirmation, and only a confirmed upgrade writes", () => {
    const conn = scoped(WEB, ["read"], ["send"]);
    const asked: unknown[] = [];
    const upgraded: Candidate[] = [];
    const picker: ConnectionPicker = {
      ...withConnect(pickerOver([conn])),
      setUpgradeTargetId: (id) => asked.push(id),
      upgradeScopes: async (c) => {
        upgraded.push(c);
        return true;
      },
    };
    // The click names the connection to confirm, and writes nothing.
    const idle = warningTree(conn, picker);
    expect(confirmModalProps(idle)?.open).toBe(false);
    (propsOf(idle, `member-pick-upgrade-${WEB}`)?.onClick as () => void)();
    expect(asked).toEqual([WEB]);
    expect(upgraded).toEqual([]);
    // Named, it opens the confirmation; confirming upgrades and closes it.
    const confirming = warningTree(conn, { ...picker, upgradeTargetId: WEB });
    const modal = confirmModalProps(confirming);
    expect(modal?.open).toBe(true);
    (modal?.onConfirm as () => void)();
    expect(upgraded).toEqual([conn]);
    expect(asked).toEqual([WEB, null]);
    // Another connection's pending confirmation is not this one's.
    const other = warningTree(conn, { ...picker, upgradeTargetId: DB });
    expect(confirmModalProps(other)?.open).toBe(false);
  });

  it("a renew sends no scopes, an upgrade only the missing ones, a new connection the agent's", async () => {
    const conn = scoped(WEB, ["read", "labels"], ["send"]);
    const opened: Array<Parameters<OpenPopup>[0]> = [];
    const picker = pickerOver([conn], {
      agentScopes: ["send", "labels"],
      openPopup: async (input) => {
        opened.push(input);
        return false;
      },
    });
    await picker.renewConnection(conn);
    await picker.upgradeScopes(conn);
    await picker.triggerConnect("primary");
    expect(opened).toEqual([
      { packageId: INTEGRATION, authKey: "primary", connectionId: WEB },
      { packageId: INTEGRATION, authKey: "primary", scopes: ["send"], connectionId: WEB },
      {
        packageId: INTEGRATION,
        authKey: "primary",
        scopes: ["send", "labels"],
        forceAccountSelect: true,
      },
    ]);
  });

  // A `"*"` asks for the auth's `default_scopes` whether the agent writes it or inherits it
  // from the integration's `default_tools`; inherited tool names ask for nothing.
  it('a new connection asks for the same scopes under an inherited `"*"` as under a written one', async () => {
    const defaulting = (defaultTools: string[] | "*") =>
      ({
        ...OAUTH,
        allow_undeclared_tools: true,
        default_tools: defaultTools,
        tools_policy: { send_mail: { required_scopes: { primary: ["send"] } } },
      }) as unknown as IntegrationManifestView;
    const asked = async (opts: Parameters<typeof pickerOver>[1]) => {
      const opened: Array<Parameters<OpenPopup>[0]> = [];
      const picker = pickerOver([], {
        ...opts,
        openPopup: async (input) => {
          opened.push(input);
          return false;
        },
      });
      await picker.triggerConnect("primary");
      return { scopes: opened[0]!.scopes, named: picker.connectsWithAgentScopes("primary") };
    };

    const wildcard = { scopes: ["read"], named: true };
    expect(await asked({ agentTools: "*" })).toEqual(wildcard);
    expect(await asked({ manifest: defaulting("*") })).toEqual(wildcard);
    expect(await asked({ manifest: defaulting(["send_mail"]) })).toEqual({
      scopes: undefined,
      named: false,
    });
    expect(await asked({ manifest: defaulting("*"), agentTools: ["send_mail"] })).toEqual({
      scopes: ["send"],
      named: true,
    });
  });

  it("shows each row's grant against the agent, and offers a connection with its scopes", () => {
    const exact = scoped(DB, ["read", "send"]);
    const broader = scoped(LABELS, ["read", "send", "labels"], [], { scope_fit: "broader" });
    const short = scoped(WEB, ["read"], ["send"]);
    const picker = pickerOver([short, broader, exact], { agentScopes: ["send"] });
    const trees: ReactNode[] = [];
    render(<MenuProbe picker={picker} onTree={(tree) => trees.push(tree)} />);
    const row = (id: string) => propsOf(trees[0], `member-pick-option-${id}`)?.children;
    const add = propsOf(trees[0], `member-pick-add-${INTEGRATION}-primary`)?.children;
    const t = (key: string, opts?: Record<string, unknown>) =>
      i18n.t(`agents:detail.integrationMemberPicker.${key}`, opts);

    expect(summaryOf(row(DB))).toContain(">Send · Read</span>");
    expect(textsOf(row(DB))).not.toContain(t("broaderThanAgent"));
    expect(summaryOf(row(LABELS))).toContain(">Send · Labels +1</span>");
    expect(textsOf(row(LABELS))).toContain(t("broaderThanAgent"));
    expect(textsOf(row(WEB))).toContain(t("missingScopes", { scopes: "Send" }));
    expect(summaryOf(row(WEB))).toBeUndefined();
    expect(textsOf(add)).toContain(t("newWithAgentScopes"));
  });
});

/** The row's `ScopeSummaryText`, rendered, if it shows one. */
function summaryOf(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = summaryOf(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<{ children?: unknown }>(node)) return undefined;
  if (node.type === ScopeSummaryText) return render(node);
  return summaryOf(node.props.children);
}

describe("PickerMenu — one way to read the state", () => {
  const t = (key: string, opts?: Record<string, unknown>) =>
    i18n.t(`agents:detail.integrationMemberPicker.${key}`, opts);

  function menuFor(res: Resolution, persistence?: Persistence) {
    const qc = new QueryClient();
    qc.setQueryData(READINESS_KEY, readiness(res));
    const pickers: Array<ConnectionPicker | null> = [];
    render(
      <PickerProbe
        persistence={persistence ?? { mode: "pin" }}
        onPicker={(p) => pickers.push(p)}
      />,
      { queryClient: qc },
    );
    const trees: ReactNode[] = [];
    render(<MenuProbe picker={pickers[0]!} onTree={(tree) => trees.push(tree)} />, {
      queryClient: qc,
    });
    const item = (id: string) => propsOf(trees[0], id);
    return {
      inherit: item(`member-pick-reset-${INTEGRATION}`),
      web: item(`member-pick-option-${WEB}`),
      db: item(`member-pick-option-${DB}`),
      none: item(`member-pick-none-${INTEGRATION}`),
    };
  }

  /** The `description` prop of the choice's label, which is what the row says about it. */
  function descriptionOf(node: unknown): string | undefined {
    if (Array.isArray(node)) return node.map(descriptionOf).find((d) => d !== undefined);
    if (!isValidElement<{ description?: unknown; children?: unknown }>(node)) return undefined;
    if (typeof node.props.description === "string") return node.props.description;
    return descriptionOf(node.props.children);
  }

  it("ticks only 'Hériter' while nothing is chosen, and says what it gives", () => {
    const menu = menuFor(
      resolution({
        source: "org_default",
        org_default_connection_ids: [WEB],
        resolved_connection_ids: [WEB],
      }),
    );
    expect(menu.inherit).toMatchObject({ "aria-checked": true });
    expect(menu.web).toMatchObject({ "aria-checked": false });
    expect(menu.db).toMatchObject({ "aria-checked": false });
    expect(menu.none).toMatchObject({ "aria-checked": false });
    expect(descriptionOf(menu.inherit?.children)).toBe(
      t("inheritFromSpaceDefault", { name: "web", count: 1 }),
    );
    // No row is greyed for being the current choice.
    expect(menu.inherit?.disabled).toBe(false);
    expect(menu.none?.disabled).toBe(false);
  });

  it("ticks only what is chosen, never 'Hériter' beside it", () => {
    const menu = menuFor(
      resolution({ member_pinned_connection_ids: [WEB], resolved_connection_ids: [WEB] }),
    );
    expect(menu.inherit).toMatchObject({ "aria-checked": false });
    expect(menu.web).toMatchObject({ "aria-checked": true });
    expect(menu.db).toMatchObject({ "aria-checked": false });
    expect(menu.none).toMatchObject({ "aria-checked": false });
    // Under a pin the verdict is the pin: inheriting is not named after it.
    expect(descriptionOf(menu.inherit?.children)).toBe(t("inheritGeneric"));
  });

  it("an override inherits what the cascade binds, whoever binds it", () => {
    const menu = menuFor(resolution({ source: "member_pin", resolved_connection_ids: [DB] }), {
      mode: "override",
      value: null,
      onChange: () => {},
    });
    expect(menu.inherit).toMatchObject({ "aria-checked": true });
    expect(descriptionOf(menu.inherit?.children)).toBe(t("inheritFromPin", { name: "db" }));
  });
});

describe("IntegrationConnectionPicker — an unset override", () => {
  const t = (key: string, opts?: Record<string, unknown>) =>
    i18n.t(`agents:detail.integrationMemberPicker.${key}`, opts);
  const OVERRIDE = { mode: "override", onChange: () => {} } as const;
  const unset: Persistence = { ...OVERRIDE, value: null };
  const picked = (value: string[]): Persistence => ({ ...OVERRIDE, value });
  const fallback = resolution({ source: "fallback_auto", resolved_connection_ids: [WEB] });
  const inheriting = (name: string) => t("inheritTrigger", { name });

  it("reads « Hériter » when the cascade binds nothing, amber while runs are blocked", () => {
    const unbound = resolution({ candidates: [], resolved_connection_ids: [] });
    const html = renderPicker(unbound, true, unset);
    expect(html).toContain(t("inherit"));
    expect(html).toContain("text-warning");
    // Control: the same state on an integration the run starts without does not warn.
    expect(renderPicker(unbound, false, unset)).not.toContain("text-warning");
  });

  it("names the connection the cascade binds after « Hériter », in both modes", () => {
    for (const persistence of [unset, undefined]) {
      const html = renderPicker(fallback, false, persistence);
      expect(html).toContain(inheriting("web"));
      expect(html).not.toContain("text-warning");
    }
  });

  it("names a set the cascade binds whole", () => {
    const html = renderPicker(
      resolution({
        source: "org_default",
        org_default_connection_ids: [WEB, DB],
        resolved_connection_ids: [WEB, DB],
      }),
      false,
      unset,
    );
    expect(html).toContain(inheriting("web · db"));
  });

  it("inherits the member's own pin under an unset override, and shows a set override as chosen", () => {
    const pinned = resolution({
      member_pinned_connection_ids: [WEB],
      resolved_connection_ids: [WEB],
    });
    expect(renderPicker(pinned, false, unset)).toContain(inheriting("web"));
    // The same connection, chosen: here as an override, on the agent page as the pin itself.
    const override = renderPicker(fallback, false, picked([WEB]));
    for (const chosen of [override, renderPicker(pinned, false)]) {
      expect(chosen).toContain(">web<");
      expect(chosen).not.toContain(t("inherit"));
    }
  });

  it("warns on an inherited connection that blocks the run, and names why", () => {
    const dead = resolution({
      source: "fallback_auto",
      error_code: "needs_reconnection",
      resolved_connection_ids: [WEB],
      candidates: [{ ...candidate(WEB, "web"), needs_reconnection: true }, candidate(DB, "db")],
    });
    const html = renderPicker(dead, true, unset);
    expect(html).toContain(inheriting("web"));
    expect(html).toContain("text-warning");
    expect(html).toContain(`member-pick-dead-warning-${INTEGRATION}`);
    // A set override replaces what the cascade binds: the run's verdict is the override's own.
    const overridden = renderPicker(dead, true, picked([DB]));
    expect(overridden).toContain(">db<");
    expect(overridden).not.toContain("text-warning");
    expect(overridden).not.toContain(`member-pick-dead-warning-${INTEGRATION}`);
  });

  it("names whole an inherited set with a member gone: the space default's, or the member's pin", () => {
    const count = `${t("selectedCount", { count: 2 })} · ${t("unavailableCount", { count: 1 })}`;
    const brokenDefault = renderPicker(
      resolution({
        source: "org_default",
        error_code: "pinned_connection_unavailable",
        org_default_connection_ids: [WEB, GONE],
      }),
      true,
      unset,
    );
    expect(brokenDefault).toContain(count);
    expect(brokenDefault).toContain(t("defaultUnavailableWarning", { count: 1 }));
    const brokenPin = renderPicker(
      resolution({
        error_code: "pinned_connection_unavailable",
        member_pinned_connection_ids: [WEB, GONE],
      }),
      true,
      unset,
    );
    expect(brokenPin).toContain(count);
    expect(brokenPin).toContain(t("unavailableWarning", { count: 1 }));
    // A set override speaks for itself, whatever the layers under it hold.
    const overridden = renderPicker(
      resolution({ member_pinned_connection_ids: [WEB, GONE] }),
      true,
      picked([DB]),
    );
    expect(overridden).not.toContain(WARNING);
    expect(overridden).not.toContain("text-warning");
  });

  it("leaves « Aucune connexion » selectable over the member's own, until it is the override", () => {
    const pinnedNone = resolution({ source: null, member_pinned_connection_ids: [] });
    const noneItem = (persistence: Persistence) =>
      propsOf(menuOf(pickerFor(pinnedNone, { persistence })), `member-pick-none-${INTEGRATION}`)!;
    expect(noneItem(unset)).toMatchObject({ "aria-checked": false, disabled: false });
    expect(noneItem(picked([]))).toMatchObject({ "aria-checked": true });
  });
});

describe("IntegrationConnectionPicker — the trigger against an uncommitted draft", () => {
  const dead = { ...candidate(DB, "db"), needs_reconnection: true };
  const verdict = resolution({ candidates: [candidate(WEB, "web"), dead] });
  const override = (value: string[]): Persistence => ({
    mode: "override",
    value,
    onChange: () => {},
  });
  const trigger = (picker: ConnectionPicker) =>
    render(<PickerMenu integrationId={INTEGRATION} picker={picker} />);

  it("a ticked dead connection warns under the picker, and turns the trigger amber once it is the pick", () => {
    const drafting = pickerFor(verdict, { persistence: override([WEB]), tick: DB });
    expect(drafting.checkedIds).toEqual([WEB, DB]);
    expect(drafting.deadConns.map((c) => c.id)).toEqual([DB]);
    const html = trigger(drafting);
    expect(html).toContain(">web<");
    expect(html).not.toContain("text-warning");
    // Control: the same set, committed.
    const committed = pickerFor(verdict, { persistence: override([WEB, DB]) });
    expect(committed.deadConns.map((c) => c.id)).toEqual([DB]);
    expect(trigger(committed)).toContain("text-warning");
  });
});
