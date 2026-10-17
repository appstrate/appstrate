// SPDX-License-Identifier: Apache-2.0

/**
 * The connections cell and its « Modifier » modal. The cell reads what binds (the imposed
 * connections behind a padlock) and says each problem on its own line; a closed imposed set is
 * read-only. The modal ticks the candidates and writes once: the ticked set, `null` (« Revenir au
 * choix par défaut ») or `[]` (« Aucune connexion », only for an integration the agent does not
 * require and nothing imposes). Under an imposed set open to additions the writes hold the
 * additions alone, and unticking them all is « no addition ». Plus how a connect popup's new
 * connection is placed, and a stored member that is gone: the server never binds what is left,
 * so the cell says so instead of showing the survivors as the whole selection.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
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
import type { ConnectionSet } from "../../../lib/connection-set.ts";
import { ConfirmModal } from "../../confirm-modal.tsx";
import { FormModal } from "../../form-modal.tsx";
import { IntegrationConnectionPicker } from "../integration-connection-picker.tsx";
import {
  ConnectionPickerFields,
  ConnectionPickerModal,
  ProblemActions,
} from "../connection-picker-modal.tsx";
import {
  useConnectionPicker,
  type ConnectionPicker,
  type ConnectionPickerDeps,
  type ConnectionPickerPersistence,
  type PickerProblem,
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
const PIN_PATH = "/api/me/integration-pins/{agentPackageId}/integrations/{integrationPackageId}";

const MANIFEST = {
  auths: { primary: { type: "custom" } },
} as unknown as IntegrationManifestView;

const t = (key: string, opts?: Record<string, unknown>) =>
  i18n.t(`agents:detail.integrationMemberPicker.${key}`, opts);

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
    additional_connections_allowed: false,
    can_add_connection: true,
    candidates: [candidate(WEB, "web"), candidate(DB, "db")],
    ...overrides,
  };
}

type Persistence = ConnectionPickerPersistence;
const override = (value: ConnectionSet, onChange: (ids: ConnectionSet) => void = () => {}) =>
  ({ mode: "override", value, onChange }) as const;

/** The one readiness query the picker reads, under the key it builds. */
const READINESS_KEY = $api.queryOptions("get", "/api/agents/{scope}/{name}/connection-readiness", {
  params: {
    path: { scope: "@acme", name: "ops" },
    header: { "X-Org-Id": undefined, "X-Space-Id": undefined },
  },
}).queryKey;

/** The integration detail the picker reads its manifest and auths from. */
const DETAIL_KEY = $api.queryOptions("get", "/api/integrations/{packageId}", {
  params: {
    path: { packageId: INTEGRATION },
    header: { "X-Org-Id": undefined, "X-Space-Id": undefined },
  },
}).queryKey;

function withDetail(qc: QueryClient): QueryClient {
  qc.setQueryData(DETAIL_KEY, { manifest: MANIFEST, auths: [] });
  return qc;
}

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

/** The cell, rendered: the modal is mounted only once « Modifier » is clicked. */
function renderPicker(
  res: Resolution,
  runBlocking: boolean,
  persistence?: Persistence,
  required = false,
): string {
  const qc = withDetail(new QueryClient());
  qc.setQueryData(READINESS_KEY, readiness(res, runBlocking, required));
  return render(
    <IntegrationConnectionPicker
      integration={{ id: INTEGRATION }}
      agentPackageId={AGENT}
      {...(persistence ? { persistence } : {})}
    />,
    { queryClient: qc },
  );
}

const WARNING = `member-pick-unavailable-warning-${INTEGRATION}`;
const LOCKED_WARNING = `member-pick-locked-unavailable-warning-${INTEGRATION}`;
const EDIT = `member-pick-edit-${INTEGRATION}`;
const LOCKED = `member-pick-locked-${INTEGRATION}`;

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

/** The picker's state for a verdict, as the hook computes it. */
function pickerFor(
  res: Resolution,
  opts: { required?: boolean; persistence?: Persistence } = {},
): ConnectionPicker {
  const qc = new QueryClient();
  qc.setQueryData(READINESS_KEY, readiness(res, false, opts.required ?? false));
  const pickers: Array<ConnectionPicker | null> = [];
  render(
    <PickerProbe
      persistence={opts.persistence ?? { mode: "pin" }}
      onPicker={(p) => pickers.push(p)}
    />,
    { queryClient: qc },
  );
  const picker = pickers[pickers.length - 1];
  if (!picker) throw new Error("the readiness verdict should be loaded");
  return picker;
}

/** The props of the element carrying `testId`, searched through every element-valued prop. */
function propsOf(node: unknown, testId: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child, testId);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (node.props["data-testid"] === testId) return node.props;
  for (const value of Object.values(node.props)) {
    const found = propsOf(value, testId);
    if (found) return found;
  }
  return undefined;
}

const click = (props: Record<string, unknown> | undefined) => {
  if (!props) throw new Error("no such control");
  (props.onClick as () => void)();
};

type ModalElement = ReactElement<ComponentProps<typeof FormModal>>;
type FieldsElement = ReactElement<ComponentProps<typeof ConnectionPickerFields>>;
const fieldsOf = (modal: ModalElement) => modal.props.children as FieldsElement;

/**
 * The modal's element tree (its chrome is a portal a static render drops), after `ticks` were
 * toggled in turn, each a render of its own.
 */
function modalFor(
  picker: ConnectionPicker,
  opts: { ticks?: string[]; onClose?: () => void } = {},
): ModalElement {
  const ticks = opts.ticks ?? [];
  const modals: ModalElement[] = [];
  function Probe() {
    const modal = ConnectionPickerModal({
      integrationId: INTEGRATION,
      picker,
      onClose: opts.onClose ?? (() => {}),
    }) as ModalElement;
    modals.push(modal);
    // A state update during the probe's own render: React renders it again with the tick.
    const next = ticks[modals.length - 1];
    if (next !== undefined) fieldsOf(modal).props.onToggle(next);
    return null;
  }
  render(<Probe />, { queryClient: withDetail(new QueryClient()) });
  return modals[modals.length - 1]!;
}

/** The modal's body, rendered: its boxes, problem lines and connect buttons. */
function fieldsHtml(picker: ConnectionPicker, ticked = picker.initialTicks, qc?: QueryClient) {
  return render(
    <ConnectionPickerFields
      integrationId={INTEGRATION}
      picker={picker}
      ticked={ticked}
      onToggle={() => {}}
      onConnect={() => {}}
      upgradeTargetId={null}
      onUpgradeTarget={() => {}}
    />,
    qc ? { queryClient: qc } : {},
  );
}

/** The state a box is drawn in, read off the static markup. */
function box(html: string, id: string): { checked: boolean; disabled: boolean } {
  const tag = html.match(new RegExp(`<button[^>]*data-testid="member-pick-option-${id}"[^>]*>`));
  if (!tag) throw new Error(`no box for ${id}`);
  return {
    checked: tag[0].includes('data-state="checked"'),
    disabled: / disabled=""/.test(tag[0]),
  };
}

describe("IntegrationConnectionPicker — a stored member is gone", () => {
  it("names the survivors and how many are unavailable, and says why runs are blocked", () => {
    const html = renderPicker(
      resolution({
        error_code: "pinned_connection_unavailable",
        member_pinned_connection_ids: [WEB, GONE],
      }),
      true,
    );
    expect(html).toContain(`web · ${t("unavailableCount", { count: 1 })}`);
    expect(html).toContain(WARNING);
    expect(html).toContain(t("unavailableWarning", { count: 1 }));
  });

  it("shows neither the count nor the warning while every stored member is reachable", () => {
    const html = renderPicker(
      resolution({ member_pinned_connection_ids: [WEB, DB], resolved_connection_ids: [WEB, DB] }),
      false,
    );
    expect(html).not.toContain(WARNING);
    expect(html).toContain("web · db");
  });

  it("keeps « Modifier » when nothing is left to pick, so the stored set can be reset", () => {
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
    expect(html).toContain(EDIT);
    expect(html).toContain(WARNING);
  });

  it("warns in override mode too — a schedule would fail at every fire", () => {
    const html = renderPicker(resolution({}), false, override([DB, GONE]));
    expect(html).toContain(WARNING);
    expect(html).toContain("text-warning");
  });

  it("says the gone members in the modal too, which « Enregistrer » drops", () => {
    const picker = pickerFor(
      resolution({
        error_code: "pinned_connection_unavailable",
        member_pinned_connection_ids: [WEB, GONE],
      }),
    );
    expect(picker.initialTicks).toEqual([WEB]);
    expect(fieldsHtml(picker)).toContain(`member-pick-modal-unavailable-warning-${INTEGRATION}`);
    // Untouched, the survivors are writable: the stored set differs from them.
    expect(picker.saveValue([WEB])).toEqual([WEB]);
    expect(modalFor(picker).props.submitDisabled).toBe(false);
  });
});

describe("IntegrationConnectionPicker — the verdict's precise cause", () => {
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
    expect(html).toContain(`web · ${t("unavailableCount", { count: 1 })}`);
    expect(html).toContain(t("unavailableWarning", { count: 1 }));
  });

  it("a soft default with a member serving no selected tool is named whole", () => {
    const html = renderPicker(
      resolution({
        source: "org_default",
        error_code: "auth_serves_no_selected_tool",
        org_default_connection_ids: [WEB, GONE],
        resolved_connection_ids: [WEB, GONE],
      }),
      true,
    );
    expect(html).toContain(`web · ${t("unavailableCount", { count: 1 })}`);
    expect(html).toContain(t("defaultUnavailableWarning", { count: 1 }));
    expect(html).not.toContain(t("unavailableWarning", { count: 1 }));
  });

  it("a soft default naming an unreachable connection says the default is unavailable", () => {
    const html = renderPicker(
      resolution({
        source: "org_default",
        error_code: "pinned_connection_unavailable",
        org_default_connection_ids: [GONE],
      }),
      true,
    );
    expect(html).not.toContain(t("connectLabel"));
    expect(html).toContain(t("unavailableCount", { count: 1 }));
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
    expect(html).toContain(EDIT);
  });

  it("reads a fallback-bound connection as what the cell inherits", () => {
    const html = renderPicker(
      resolution({ source: "fallback_auto", resolved_connection_ids: [WEB] }),
      false,
    );
    expect(html).toContain(t("inheritTrigger", { name: "web" }));
  });

  it("is read-only on a stored admin pin, whatever the verdict names", () => {
    // `auth_key_mismatch` names no layer, yet the admin pin would still override any pick.
    const html = renderPicker(
      resolution({
        source: null,
        error_code: "auth_key_mismatch",
        admin_pinned_connection_ids: [WEB],
      }),
      true,
    );
    expect(html).toContain(LOCKED);
    expect(html).not.toContain(EDIT);
    expect(html).toContain(t("lockedByAdminPin", { count: 1 }));
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
    expect(html).toContain(LOCKED);
    expect(html).not.toContain(GONE);
    expect(html).toContain(t("unavailableCount", { count: 1 }));
    expect(html).toContain(LOCKED_WARNING);
    expect(html).toContain(t("lockedUnavailableWarning", { count: 1 }));
    expect(html).toContain("text-warning");
  });

  it("offers to clear an override stored under a lock, the server's only way out of it", () => {
    const locked = resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB] });
    const clear = `member-pick-clear-${INTEGRATION}`;
    const withOverride = renderPicker(locked, false, override([DB]));
    expect(withOverride).toContain(LOCKED);
    expect(withOverride).toContain(clear);
    expect(withOverride).toContain(i18n.t("agents:connectionOverrides.clearChoice"));
    expect(renderPicker(locked, false, override(null))).not.toContain(clear);
    expect(renderPicker(locked, false)).not.toContain(clear);
  });

  it("shows the whole lock under an override stored within it, a no-op that can be cleared", () => {
    // Nothing narrows a lock: the server binds the locked set whatever a subset of it says.
    const html = renderPicker(
      resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB, DB] }),
      false,
      override([DB]),
    );
    expect(html).toContain(LOCKED);
    expect(html).toContain("web · db");
    expect(html).not.toContain(`member-pick-outranked-warning-${INTEGRATION}`);
    expect(html).toContain(`member-pick-clear-${INTEGRATION}`);
  });

  it("judges a lock on the locked set, whatever an override within it names", () => {
    // The admin pin holds a dead member, so the cascade blocks: no override within it escapes.
    const deadWeb = { ...candidate(WEB, "web"), needs_reconnection: true };
    const locked = resolution({
      source: "admin_pin",
      admin_pinned_connection_ids: [WEB, DB],
      candidates: [deadWeb, candidate(DB, "db")],
    });
    for (const value of [null, [DB], [WEB], []]) {
      const html = renderPicker(locked, true, override(value));
      expect(html).toContain(LOCKED);
      expect(html).toContain("text-warning");
    }
    // "No connection" under a healthy lock binds the lock: it gates nothing, required or not.
    const healthy = resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB, DB] });
    expect(renderPicker(healthy, false, override([]), true)).not.toContain("text-warning");
    expect(renderPicker(healthy, false, override([]))).not.toContain("text-warning");
  });

  it("says why an override reaching outside the lock is refused, whatever the cascade binds", () => {
    const outranked = `member-pick-outranked-warning-${INTEGRATION}`;
    const locked = resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB] });
    const html = renderPicker(locked, false, override([DB]));
    expect(html).toContain("text-warning");
    expect(html).toContain(outranked);
    expect(html).toContain(i18n.t("agents:error.overrideOutranked"));
    expect(html).toContain(`member-pick-clear-${INTEGRATION}`);
    // Control: an override within the lock is not refused.
    const within = renderPicker(locked, false, override([WEB]));
    expect(within).not.toContain(outranked);
    expect(within).not.toContain("text-warning");
  });

  it("a soft org default leaves the cell editable", () => {
    const html = renderPicker(
      resolution({ source: "org_default", org_default_connection_ids: [WEB] }),
      false,
    );
    expect(html).not.toContain(LOCKED);
    expect(html).toContain(EDIT);
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
    expect(html).not.toContain(EDIT);
    expect(html).not.toContain(LOCKED);
  });
});

describe("IntegrationConnectionPicker — what the modal writes", () => {
  it("opens on what binds, and writes nothing while it is untouched", () => {
    const fallback = pickerFor(
      resolution({ source: "fallback_auto", resolved_connection_ids: [WEB] }),
    );
    expect(fallback.initialTicks).toEqual([WEB]);
    expect(box(fieldsHtml(fallback), WEB)).toEqual({ checked: true, disabled: false });
    expect(box(fieldsHtml(fallback), DB)).toEqual({ checked: false, disabled: false });
    expect(modalFor(fallback).props.submitDisabled).toBe(true);
    const pinned = pickerFor(resolution({ member_pinned_connection_ids: [DB] }));
    expect(pinned.initialTicks).toEqual([DB]);
    expect(modalFor(pinned).props.submitDisabled).toBe(true);
  });

  it("writes the ticked set, as an override or as the member's pin", async () => {
    const changes: ConnectionSet[] = [];
    const overridden = pickerFor(
      resolution({ source: "fallback_auto", resolved_connection_ids: [WEB] }),
      {
        persistence: override(null, (ids) => changes.push(ids)),
      },
    );
    const ticked = modalFor(overridden, { ticks: [DB] });
    expect(ticked.props.submitDisabled).toBe(false);
    ticked.props.onSubmit({ preventDefault() {} } as never);
    await Bun.sleep(0);
    expect(changes).toEqual([[WEB, DB]]);

    const put = spyOn(client, "PUT").mockResolvedValue({ data: {} });
    try {
      const member = pickerFor(resolution({ member_pinned_connection_ids: [WEB] }));
      modalFor(member, { ticks: [WEB, DB] }).props.onSubmit({ preventDefault() {} } as never);
      await Bun.sleep(0);
      const calls = put.mock.calls as unknown as Array<[string, { body: unknown }]>;
      expect(calls.map(([path, init]) => [path, init.body])).toEqual([
        [PIN_PATH, { connection_ids: [DB] }],
      ]);
    } finally {
      put.mockRestore();
    }
  });

  it("never writes an empty tick: « Aucune connexion » is its own action", () => {
    const picker = pickerFor(resolution({ member_pinned_connection_ids: [WEB] }));
    expect(modalFor(picker, { ticks: [WEB] }).props.submitDisabled).toBe(true);
    expect(picker.saveValue([])).toBeUndefined();
  });

  it("persists [] for « Aucune connexion » and null for « Revenir au choix par défaut »", () => {
    const written: ConnectionSet[] = [];
    const picker = pickerFor(resolution({}), {
      persistence: override([WEB], (ids) => written.push(ids)),
    });
    const modal = modalFor(picker);
    click(propsOf(modal.props.secondaryActions, `member-pick-none-${INTEGRATION}`));
    click(propsOf(modal.props.secondaryActions, `member-pick-default-${INTEGRATION}`));
    expect(written).toEqual([[], null]);
  });

  it("offers « Revenir au choix par défaut » only over a choice", () => {
    expect(pickerFor(resolution({ member_pinned_connection_ids: [WEB] })).offersDefault).toBe(true);
    expect(pickerFor(resolution({ member_pinned_connection_ids: [] })).offersDefault).toBe(true);
    const unset = pickerFor(resolution({}), { persistence: override(null) });
    expect(unset.offersDefault).toBe(false);
    expect(
      propsOf(modalFor(unset).props.secondaryActions, `member-pick-default-${INTEGRATION}`),
    ).toBeUndefined();
  });

  it("closes on an accepted write and stays open on a refused one", async () => {
    const closes = async (accepted: boolean) => {
      let closed = 0;
      const picker = { ...pickerFor(resolution({})), persist: async () => accepted };
      modalFor(picker, { ticks: [WEB], onClose: () => closed++ }).props.onSubmit({
        preventDefault() {},
      } as never);
      await Bun.sleep(0);
      return closed;
    };
    expect(await closes(true)).toBe(1);
    expect(await closes(false)).toBe(0);
  });

  it("reports a refused pin write, and reads no verdict it did not move", async () => {
    const put = spyOn(client, "PUT").mockRejectedValue(new ApiError("forbidden", "no", 403));
    try {
      expect(await pickerFor(resolution({})).persist([WEB])).toBe(false);
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      put.mockRestore();
    }
  });

  it("refuses a tick past the cap", () => {
    const full = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION }, (_, i) =>
      candidate(`c${i}`, `c${i}`),
    );
    const picker = pickerFor(
      resolution({
        candidates: [...full, candidate(DB, "db")],
        member_pinned_connection_ids: full.map((c) => c.id),
      }),
    );
    const html = fieldsHtml(picker);
    expect(box(html, DB)).toEqual({ checked: false, disabled: true });
    expect(box(html, "c0")).toEqual({ checked: true, disabled: false });
    expect(html).toContain(t("maxReached", { max: MAX_CONNECTIONS_PER_INTEGRATION }));
  });
});

describe("IntegrationConnectionPicker — 'no connection'", () => {
  it("surfaces the agent's `required` flag, which withholds 'no connection'", () => {
    const unbound = resolution({ source: null, resolved_connection_ids: [] });
    expect(pickerFor(unbound).required).toBe(false);
    expect(pickerFor(unbound).offersNone).toBe(true);
    const required = pickerFor(unbound, { required: true });
    expect(required.required).toBe(true);
    expect(required.offersNone).toBe(false);
    expect(
      propsOf(modalFor(required).props.secondaryActions, `member-pick-none-${INTEGRATION}`),
    ).toBeUndefined();
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
          persistence={override(null)}
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

  it("shows a stored 'no connection' as such, ticking nothing, and never the cascade", () => {
    const res = resolution({
      source: null,
      member_pinned_connection_ids: [],
      resolved_connection_ids: [],
    });
    const picker = pickerFor(res);
    expect(picker.pickedNone).toBe(true);
    expect(picker.initialTicks).toEqual([]);
    // Already the choice: not offered again.
    expect(picker.offersNone).toBe(false);
    expect(renderPicker(res, false)).toContain(t("none"));
    // Control: no pin at all is not "no connection" — the cell asks to connect.
    const unpinned = renderPicker(resolution({ source: null, resolved_connection_ids: [] }), false);
    expect(unpinned).not.toContain(t("none"));
    expect(unpinned).toContain(t("connectLabel"));
  });

  it("an override of 'no connection' shows itself: the cell never shows the cascade's set", () => {
    const fallback = resolution({ source: "fallback_auto", resolved_connection_ids: [WEB] });
    const html = renderPicker(fallback, false, override([]));
    expect(html).toContain(t("none"));
    expect(html).not.toContain(">web<");
    expect(pickerFor(fallback, { persistence: override([]) }).initialTicks).toEqual([]);
  });

  it("warns on a stored 'no connection' override for an integration the agent requires", () => {
    const html = renderPicker(resolution({}), false, override([]), true);
    expect(html).toContain(t("none"));
    expect(html).toContain("text-warning");
    // Control: the same override on an integration the agent does not require is a choice.
    expect(renderPicker(resolution({}), false, override([]))).not.toContain("text-warning");
  });

  it("an admin pin to none locks the cell on 'no connection'", () => {
    const html = renderPicker(
      resolution({ source: null, admin_pinned_connection_ids: [], resolved_connection_ids: [] }),
      false,
    );
    expect(html).toContain(LOCKED);
    expect(html).toContain(t("none"));
  });

  it("under a lock, a stored 'no connection' override still binds the lock, and can be cleared", () => {
    const html = renderPicker(
      resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB] }),
      false,
      override([]),
    );
    expect(html).toContain(LOCKED);
    expect(html).not.toContain(t("none"));
    expect(html).toContain(">web<");
    expect(html).toContain(`member-pick-clear-${INTEGRATION}`);
  });

  it("an enforced org default offers nothing to pick: the cell is read-only", () => {
    const html = renderPicker(
      resolution({
        source: "org_default_enforced",
        org_default_connection_ids: [WEB],
        org_default_enforced: true,
        resolved_connection_ids: [WEB],
      }),
      false,
    );
    expect(html).toContain(LOCKED);
    expect(html).toContain(t("lockedByEnforcedDefault"));
    expect(html).not.toContain(EDIT);
    expect(html).not.toContain(t("none"));
  });

  // Nothing removes a locked connection, so « Aucune connexion » is no answer under a lock.
  it("never offers 'no connection' under a lock, whatever the persistence", () => {
    const pinned = resolution({ source: "admin_pin", admin_pinned_connection_ids: [WEB] });
    const enforced = resolution({
      source: "org_default_enforced",
      org_default_connection_ids: [WEB],
      org_default_enforced: true,
      resolved_connection_ids: [WEB],
    });
    const open = resolution({
      source: "admin_pin",
      admin_pinned_connection_ids: [WEB],
      additional_connections_allowed: true,
    });
    for (const locked of [pinned, enforced, open]) {
      for (const persistence of [override(null), { mode: "pin" } as const]) {
        expect(pickerFor(locked, { persistence }).offersNone).toBe(false);
      }
    }
  });

  it("leaves « Aucune connexion » offered over the member's own, until it is the override", () => {
    const pinnedNone = resolution({ source: null, member_pinned_connection_ids: [] });
    expect(pickerFor(pinnedNone, { persistence: override(null) }).offersNone).toBe(true);
    expect(pickerFor(pinnedNone, { persistence: override([]) }).offersNone).toBe(false);
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
      <IntegrationConnectionPicker integration={{ id: INTEGRATION }} agentPackageId={AGENT} />,
      { queryClient: withDetail(new QueryClient()) },
    );
    expect(loading).toContain(`member-picker-${INTEGRATION}`);
    expect(loading).not.toContain(EDIT);
  });
});

describe("IntegrationConnectionPicker — an admin pin open to additions", () => {
  const THIRD = "55555555-5555-4555-8555-555555555555";
  const open = (over: Partial<Resolution> = {}) =>
    resolution({
      source: "admin_pin",
      admin_pinned_connection_ids: [WEB],
      additional_connections_allowed: true,
      resolved_connection_ids: [WEB],
      candidates: [candidate(WEB, "web"), candidate(DB, "db"), candidate(THIRD, "third")],
      ...over,
    });

  it("keeps « Modifier », the cell naming the whole set that binds, the imposed one first", () => {
    const html = renderPicker(
      open({ member_pinned_connection_ids: [DB], resolved_connection_ids: [WEB, DB] }),
      false,
    );
    expect(html).not.toContain(LOCKED);
    expect(html).toContain(EDIT);
    expect(html).toContain("<span>web</span>");
    expect(html).toContain("· db");
    // An override replaces the member's additions; unset, it inherits them.
    expect(
      renderPicker(open({ member_pinned_connection_ids: [DB] }), false, override([THIRD])),
    ).toContain("· third");
    expect(
      renderPicker(open({ member_pinned_connection_ids: [DB] }), false, override(null)),
    ).toContain("· db");
  });

  it("ticks the imposed connection, locked and out of reach, and the additions as chosen", () => {
    const picker = pickerFor(open({ member_pinned_connection_ids: [DB] }));
    expect(picker.initialTicks).toEqual([DB]);
    const html = fieldsHtml(picker);
    expect(box(html, WEB)).toEqual({ checked: true, disabled: true });
    expect(html).toContain(`member-pick-imposed-${WEB}`);
    expect(html).toContain(t("imposedHint"));
    expect(box(html, DB)).toEqual({ checked: true, disabled: false });
    expect(html).not.toContain(`member-pick-imposed-${DB}`);
    expect(box(html, THIRD)).toEqual({ checked: false, disabled: false });
  });

  it("offers no « Revenir » for the member's pin: unticking the additions is that", () => {
    expect(
      pickerFor(open({ member_pinned_connection_ids: [DB] }), { required: true }).offersDefault,
    ).toBe(false);
    // An override keeps it: its unset value is the member's own additions.
    expect(pickerFor(open(), { persistence: override([DB]) }).offersDefault).toBe(true);
  });

  it("writes the additions alone, never an imposed id, in both persistences", async () => {
    const changes: ConnectionSet[] = [];
    const drafting = pickerFor(open(), { persistence: override(null, (ids) => changes.push(ids)) });
    modalFor(drafting, { ticks: [DB] }).props.onSubmit({ preventDefault() {} } as never);
    await Bun.sleep(0);
    expect(changes).toEqual([[DB]]);

    const put = spyOn(client, "PUT").mockResolvedValue({ data: {} });
    try {
      modalFor(pickerFor(open()), { ticks: [THIRD] }).props.onSubmit({
        preventDefault() {},
      } as never);
      await Bun.sleep(0);
      const calls = put.mock.calls as unknown as Array<[string, { body: unknown }]>;
      expect(calls.map(([path, init]) => [path, init.body])).toEqual([
        [PIN_PATH, { connection_ids: [THIRD] }],
      ]);
    } finally {
      put.mockRestore();
    }
  });

  it("writes « no addition » as `[]` for an override and as no pin for the member", async () => {
    const changes: ConnectionSet[] = [];
    const overridden = pickerFor(open(), {
      persistence: override([DB], (ids) => changes.push(ids)),
    });
    modalFor(overridden, { ticks: [DB] }).props.onSubmit({ preventDefault() {} } as never);
    await Bun.sleep(0);
    expect(changes).toEqual([[]]);

    const del = spyOn(client, "DELETE").mockResolvedValue({
      data: { schedules_disabled_count: 0 },
    });
    try {
      const member = pickerFor(open({ member_pinned_connection_ids: [DB] }));
      modalFor(member, { ticks: [DB] }).props.onSubmit({ preventDefault() {} } as never);
      await Bun.sleep(0);
      const paths = (del.mock.calls as unknown as Array<[string]>).map(([path]) => path);
      expect(paths).toEqual([PIN_PATH]);
    } finally {
      del.mockRestore();
    }
  });

  it("reads an imposed id stored in a pick as no addition: it was a narrowing, now a no-op", () => {
    const narrowed = pickerFor(open(), { persistence: override([WEB]) });
    expect(narrowed.explicitIds).toEqual([]);
    expect(narrowed.initialTicks).toEqual([]);
    const mixed = pickerFor(open(), { persistence: override([WEB, DB]) });
    expect(mixed.explicitIds).toEqual([DB]);
    expect(mixed.initialTicks).toEqual([DB]);
  });

  it("counts the imposed set towards the cap: what it leaves is all that can be ticked", () => {
    const imposed = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION - 1 }, (_, i) =>
      candidate(`c${i}`, `c${i}`),
    );
    const res = open({
      admin_pinned_connection_ids: imposed.map((c) => c.id),
      resolved_connection_ids: imposed.map((c) => c.id),
      candidates: [...imposed, candidate(DB, "db"), candidate(THIRD, "third")],
    });
    const picker = pickerFor(res);
    expect(picker.additionCap).toBe(1);
    const ticked = fieldsHtml(picker, [DB]);
    expect(box(ticked, THIRD)).toEqual({ checked: false, disabled: true });
    expect(box(ticked, DB)).toEqual({ checked: true, disabled: false });
    // One place left, two candidates: nothing ticked, both are open.
    expect(box(fieldsHtml(picker), THIRD)).toEqual({ checked: false, disabled: false });
  });

  it("says an imposed connection is unavailable apart from the additions, and gates on it", () => {
    const html = renderPicker(
      open({
        error_code: "pinned_connection_unavailable",
        admin_pinned_connection_ids: [WEB, GONE],
        resolved_connection_ids: [],
      }),
      true,
    );
    expect(html).toContain(LOCKED_WARNING);
    expect(html).not.toContain(WARNING);
    expect(html).toContain(t("unavailableCount", { count: 1 }));
    expect(html).toContain("text-warning");
  });

  it("judges an override on the whole set it binds: a dead addition or a dead imposed one", () => {
    const deadDb = { ...candidate(DB, "db"), needs_reconnection: true };
    const withDeadDb = open({
      candidates: [candidate(WEB, "web"), deadDb, candidate(THIRD, "third")],
    });
    expect(renderPicker(withDeadDb, false, override([DB]))).toContain("text-warning");
    expect(renderPicker(withDeadDb, false, override([THIRD]))).not.toContain("text-warning");
    const deadWeb = { ...candidate(WEB, "web"), needs_reconnection: true };
    const withDeadWeb = open({ candidates: [deadWeb, candidate(DB, "db")] });
    expect(renderPicker(withDeadWeb, false, override([]))).toContain("text-warning");
  });

  it("says when the imposed set and a stored override exceed the cap together", () => {
    const imposed = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION }, (_, i) =>
      candidate(`c${i}`, `c${i}`),
    );
    const html = renderPicker(
      open({
        admin_pinned_connection_ids: imposed.map((c) => c.id),
        resolved_connection_ids: imposed.map((c) => c.id),
        candidates: [...imposed, candidate(DB, "db")],
      }),
      false,
      override([DB]),
    );
    expect(html).toContain(`member-pick-too-large-warning-${INTEGRATION}`);
    expect(html).toContain("text-warning");
  });
});

describe("ConnectionPickerFields — where a candidate comes from", () => {
  const ORIGIN = "spc_origin";

  function rowsHtml(c: Candidate): string {
    const qc = new QueryClient();
    // The current org's space listing, under the key `useSpaces` reads.
    const spacesKey = $api.queryOptions("get", "/api/spaces", {
      params: { header: { "X-Org-Id": undefined } },
    }).queryKey;
    qc.setQueryData(spacesKey, {
      object: "list",
      data: [{ id: ORIGIN, name: "Marketing", access: "member", personal: false }],
      hasMore: false,
    });
    return fieldsHtml(pickerFor(resolution({ candidates: [c] })), [], qc);
  }

  // The origin reads after the connection's type: « Clé API · connectée depuis Default ».
  const inline = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

  it("tells the owner of an org-scoped row the space it was connected from", () => {
    const own = { ...candidate(WEB, "web"), origin_space_id: ORIGIN };
    expect(rowsHtml(own)).toContain(inline(t("connectedFrom", { space: "Marketing" })));
  });

  it("names the owner to anyone else, and on a space-scoped row", () => {
    const foreign = { ...candidate(WEB, "web"), is_own: false, owner_name: "Alice" };
    expect(rowsHtml(foreign)).toContain(inline(t("connectedBy", { owner: "Alice" })));
    const spaceScoped = { ...candidate(WEB, "web"), scope: "space" as const, spaceId: ORIGIN };
    expect(rowsHtml(spaceScoped)).toContain(inline(t("connectedBy", { owner: t("byYou") })));
  });

  it("falls back to the owner when the origin space is gone", () => {
    expect(rowsHtml(candidate(WEB, "web"))).toContain(
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
    const picked: ConnectionSet[] = [];
    const persistence = override(stored, (ids) => picked.push(ids));
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
    expect(await picker.triggerConnect("primary")).toBe(true);
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
        [PIN_PATH, { connection_ids: [WEB, ADDED] }],
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

  it("adds it to the modal's ticks when given, not to what bound before the edit", async () => {
    const { mounted, picked, picker } = await setup([before, withAdded], settles, [WEB]);
    await picker.triggerConnect("primary", { ticked: [DB] });
    expect(picked).toEqual([[DB, ADDED]]);
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
      expect(await picker.triggerConnect("primary")).toBe(false);
      expect(picked).toEqual([]);
      expect(warned.mock.calls as unknown[][]).toEqual([
        [t("maxReached", { max: MAX_CONNECTIONS_PER_INTEGRATION })],
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
      await expect(picker.triggerConnect("primary")).resolves.toBe(false);
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
      expect(await picker.triggerConnect("primary")).toBe(false);
      expect(picked).toEqual([]);
      expect(toasted).not.toHaveBeenCalled();
      expect(mounted.asked()).toBe(1);
      mounted.unsubscribe();
    } finally {
      toasted.mockRestore();
    }
  });

  it("a connect whose pin write is refused settles without a second write or read", async () => {
    const warned = spyOn(toast, "warning").mockImplementation(() => 0);
    const put = spyOn(client, "PUT").mockRejectedValue(new ApiError("forbidden", "no", 403));
    try {
      const { mounted, picker } = await mount([fallbackBefore, fallbackAfter], settles, {
        mode: "pin",
      });
      await expect(picker.triggerConnect("primary")).resolves.toBe(false);
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

  it("closes the modal once a connect landed, and keeps it open otherwise", async () => {
    const closes = async (landed: boolean) => {
      let closed = 0;
      const connected: unknown[][] = [];
      const picker: ConnectionPicker = {
        ...pickerFor(resolution({})),
        triggerConnect: async (...args) => {
          connected.push(args);
          return landed;
        },
      };
      const modal = modalFor(picker, { ticks: [DB], onClose: () => closed++ });
      fieldsOf(modal).props.onConnect("primary");
      await Bun.sleep(0);
      // The connect starts from the modal's ticks.
      expect(connected).toEqual([["primary", { ticked: [DB] }]]);
      return closed;
    };
    expect(await closes(true)).toBe(1);
    expect(await closes(false)).toBe(0);
  });

  // Under an admin pin open to additions the pick holds the additions alone.
  const openPin = (res: Partial<Resolution>) =>
    answer({
      source: "admin_pin",
      admin_pinned_connection_ids: [WEB],
      additional_connections_allowed: true,
      resolved_connection_ids: [WEB],
      ...res,
    });

  it("adds a connection created under an open pin as an addition, never writing the imposed one", async () => {
    const { mounted, picked, picker } = await setup(
      [openPin({}), openPin({ candidates: ALL })],
      settles,
    );
    await picker.triggerConnect("primary");
    expect(picked).toEqual([[ADDED]]);
    mounted.unsubscribe();
  });

  it("writes the member's pin with its additions and the created one, the imposed set left out", async () => {
    const put = spyOn(client, "PUT").mockResolvedValue({ data: {} });
    try {
      const pinned = { member_pinned_connection_ids: [DB], resolved_connection_ids: [WEB, DB] };
      const { mounted, picker } = await mount(
        [openPin(pinned), openPin({ ...pinned, candidates: ALL }), openPin(pinned)],
        settles,
        { mode: "pin" },
      );
      await picker.triggerConnect("primary");
      const calls = put.mock.calls as unknown as Array<[string, { body: unknown }]>;
      expect(calls.map(([, init]) => init.body)).toEqual([{ connection_ids: [DB, ADDED] }]);
      mounted.unsubscribe();
    } finally {
      put.mockRestore();
    }
  });

  it("refuses a created connection the imposed set leaves no room for, and says so", async () => {
    const warned = spyOn(toast, "warning").mockImplementation(() => 0);
    try {
      const imposed = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION }, (_, i) =>
        candidate(`c${i}`, `c${i}`),
      );
      const imposedIds = imposed.map((c) => c.id);
      const full = { admin_pinned_connection_ids: imposedIds, resolved_connection_ids: imposedIds };
      const { mounted, picked, picker } = await setup(
        [
          openPin({ ...full, candidates: imposed }),
          openPin({ ...full, candidates: [...imposed, candidate(ADDED, "new")] }),
        ],
        settles,
      );
      await picker.triggerConnect("primary");
      expect(picked).toEqual([]);
      expect(warned).toHaveBeenCalledTimes(1);
      mounted.unsubscribe();
    } finally {
      warned.mockRestore();
    }
  });

  it("writes nothing and says nothing when the settled popup created no connection", async () => {
    const failed = spyOn(toast, "error").mockImplementation(() => 0);
    const warned = spyOn(toast, "warning").mockImplementation(() => 0);
    const put = spyOn(client, "PUT").mockResolvedValue({ data: {} });
    try {
      // The refetch the popup awaited offers the same candidates as before it.
      const overridden = await setup([fallbackBefore, fallbackBefore], settles);
      await overridden.picker.triggerConnect("primary");
      expect(overridden.picked).toEqual([]);
      expect(overridden.mounted.asked()).toBe(2);
      overridden.mounted.unsubscribe();
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
      pinned?: string[];
    } = {},
  ): ConnectionPicker {
    const qc = new QueryClient();
    qc.setQueryData(
      READINESS_KEY,
      readiness(
        resolution({
          candidates,
          can_add_connection: opts.canAdd ?? true,
          member_pinned_connection_ids: opts.pinned ?? null,
        }),
      ),
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

  // `integrations:connect` comes from the org store, absent here; it is granted by hand
  // wherever the test is about something else.
  const withConnect = (picker: ConnectionPicker): ConnectionPicker => ({
    ...picker,
    canConnect: true,
    canFixInPlace: (c) => c.is_own && picker.auths[c.auth_key]?.type === "oauth2",
  });

  /** The way out of a problem, as an element tree (its confirmation is a portal). */
  function actionsOf(
    problem: PickerProblem,
    picker: ConnectionPicker,
    over: Partial<ComponentProps<typeof ProblemActions>> = {},
  ): ReactNode {
    const trees: ReactNode[] = [];
    function Probe() {
      trees.push(
        ProblemActions({
          problem,
          picker,
          onConnect: () => {},
          upgradeTargetId: null,
          onUpgradeTarget: () => {},
          ...over,
        }),
      );
      return null;
    }
    render(<Probe />);
    return trees[0];
  }

  function confirmModalProps(node: unknown): Record<string, unknown> | undefined {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = confirmModalProps(child);
        if (found) return found;
      }
      return undefined;
    }
    if (!isValidElement<Record<string, unknown>>(node)) return undefined;
    if (node.type === ConfirmModal) return node.props;
    return confirmModalProps(node.props.children);
  }

  const underScoped = (conn: Candidate): PickerProblem => ({ kind: "underScoped", conn });

  it("lists the connections in the order the server ranked them", () => {
    const picker = pickerOver([
      scoped(DB, ["read"]),
      scoped(LABELS, ["read", "labels"], [], { scope_fit: "broader" }),
      scoped(WEB, ["read"], ["send"]),
    ]);
    expect(picker.listedCandidates.map((c) => c.id)).toEqual([DB, LABELS, WEB]);
    const html = fieldsHtml(picker);
    expect(html.indexOf(`member-pick-option-${DB}`)).toBeLessThan(
      html.indexOf(`member-pick-option-${WEB}`),
    );
  });

  it("says an under-scoped pick on its own line, in the cell and in the modal", () => {
    const conn = scoped(WEB, ["read"], ["send"]);
    const picker = pickerOver([conn], { pinned: [WEB] });
    expect(picker.problems).toEqual([{ kind: "underScoped", conn }]);
    const line = t("missingScopesLine", { name: WEB, scopes: "Send" });
    expect(fieldsHtml(picker)).toContain(`member-pick-modal-scope-warning-${WEB}`);
    expect(fieldsHtml(picker)).toContain(line);
  });

  it("offers a new connection with the agent's scopes first, the in-place upgrade second", () => {
    const conn = scoped(WEB, ["read"], ["send"]);
    const html = render(<>{actionsOf(underScoped(conn), withConnect(pickerOver([conn])))}</>);
    const create = html.indexOf(`member-pick-new-for-agent-${WEB}`);
    const upgrade = html.indexOf(`member-pick-upgrade-${WEB}`);
    expect(create).toBeGreaterThan(-1);
    expect(upgrade).toBeGreaterThan(create);
  });

  it("a new connection from the line takes the under-scoped one's place", () => {
    const conn = scoped(WEB, ["read"], ["send"]);
    const connected: unknown[][] = [];
    const tree = actionsOf(underScoped(conn), pickerOver([conn]), {
      onConnect: (...args) => connected.push(args),
    });
    click(propsOf(tree, `member-pick-new-for-agent-${WEB}`));
    expect(connected).toEqual([["primary", WEB]]);
  });

  it("names creating a connection as a way out only when the actor may create one", () => {
    const conn = { ...scoped(WEB, ["read"], ["send"]), is_own: false };
    const allowed = actionsOf(underScoped(conn), withConnect(pickerOver([conn])));
    expect(propsOf(allowed, `member-pick-new-for-agent-${WEB}`)).toBeDefined();
    // A colleague's connection is theirs to upgrade.
    expect(propsOf(allowed, `member-pick-upgrade-${WEB}`)).toBeUndefined();
    const blocked = actionsOf(
      underScoped(conn),
      withConnect(pickerOver([conn], { canAdd: false })),
    );
    expect(blocked).toBeNull();
  });

  it("'Mettre à niveau' asks for a confirmation, and only a confirmed upgrade writes", () => {
    const conn = scoped(WEB, ["read"], ["send"]);
    const asked: Array<string | null> = [];
    const upgraded: Candidate[] = [];
    const picker: ConnectionPicker = {
      ...withConnect(pickerOver([conn])),
      upgradeScopes: async (c) => {
        upgraded.push(c);
        return true;
      },
    };
    const over = { onUpgradeTarget: (id: string | null) => asked.push(id) };
    // The click names the connection to confirm, and writes nothing.
    const idle = actionsOf(underScoped(conn), picker, over);
    expect(confirmModalProps(idle)?.open).toBe(false);
    click(propsOf(idle, `member-pick-upgrade-${WEB}`));
    expect(asked).toEqual([WEB]);
    expect(upgraded).toEqual([]);
    // Named, it opens the confirmation; confirming upgrades and closes it.
    const confirming = actionsOf(underScoped(conn), picker, { ...over, upgradeTargetId: WEB });
    const modal = confirmModalProps(confirming);
    expect(modal?.open).toBe(true);
    (modal?.onConfirm as () => void)();
    expect(upgraded).toEqual([conn]);
    expect(asked).toEqual([WEB, null]);
    // Another connection's pending confirmation is not this one's.
    const other = actionsOf(underScoped(conn), picker, { ...over, upgradeTargetId: DB });
    expect(confirmModalProps(other)?.open).toBe(false);
  });

  it("offers to renew a dead connection to its owner only", () => {
    const dead = { ...scoped(WEB, ["read"]), needs_reconnection: true };
    const problem: PickerProblem = { kind: "dead", conn: dead };
    expect(
      propsOf(actionsOf(problem, withConnect(pickerOver([dead]))), `member-pick-renew-${WEB}`),
    ).toBeDefined();
    const foreign = { ...dead, is_own: false };
    expect(
      actionsOf({ kind: "dead", conn: foreign }, withConnect(pickerOver([foreign]))),
    ).toBeNull();
    // Without `integrations:connect` nobody renews.
    expect(actionsOf(problem, pickerOver([dead]))).toBeNull();
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
    const html = fieldsHtml(pickerOver([short, broader, exact], { agentScopes: ["send"] }));
    const row = (id: string) => {
      const start = html.indexOf(`data-testid="member-pick-option-${id}"`);
      const next = html.indexOf('data-testid="member-pick-option-', start + 1);
      return html.slice(start, next === -1 ? undefined : next);
    };
    expect(row(DB)).toContain(">Send · Read</span>");
    expect(row(DB)).not.toContain(t("broaderThanAgent"));
    expect(row(LABELS)).toContain(">Send · Labels +1</span>");
    expect(row(LABELS)).toContain(t("broaderThanAgent"));
    expect(row(WEB)).toContain(t("missingScopes", { scopes: "Send" }));
    expect(html).toContain(`member-pick-add-${INTEGRATION}-primary`);
    expect(html).toContain(t("newWithAgentScopes"));
  });
});

describe("IntegrationConnectionPicker — an unset override", () => {
  const unset = override(null);
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
    const chosenOverride = renderPicker(fallback, false, override([WEB]));
    for (const chosen of [chosenOverride, renderPicker(pinned, false)]) {
      expect(chosen).toContain("web");
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
    expect(html).toContain(`member-pick-dead-warning-${WEB}`);
    expect(html).toContain(t("needsReconnectionLine", { name: "web" }));
    // A set override replaces what the cascade binds: the run's verdict is the override's own.
    const overridden = renderPicker(dead, true, override([DB]));
    expect(overridden).toContain("db");
    expect(overridden).not.toContain("text-warning");
    expect(overridden).not.toContain(`member-pick-dead-warning-${WEB}`);
  });

  it("names whole an inherited set with a member gone: the space default's, or the member's pin", () => {
    const named = `web · ${t("unavailableCount", { count: 1 })}`;
    const brokenDefault = renderPicker(
      resolution({
        source: "org_default",
        error_code: "pinned_connection_unavailable",
        org_default_connection_ids: [WEB, GONE],
      }),
      true,
      unset,
    );
    expect(brokenDefault).toContain(named);
    expect(brokenDefault).toContain(t("defaultUnavailableWarning", { count: 1 }));
    const brokenPin = renderPicker(
      resolution({
        error_code: "pinned_connection_unavailable",
        member_pinned_connection_ids: [WEB, GONE],
      }),
      true,
      unset,
    );
    expect(brokenPin).toContain(named);
    expect(brokenPin).toContain(t("unavailableWarning", { count: 1 }));
    // A set override speaks for itself, whatever the layers under it hold.
    const overridden = renderPicker(
      resolution({ member_pinned_connection_ids: [WEB, GONE] }),
      true,
      override([DB]),
    );
    expect(overridden).not.toContain(WARNING);
    expect(overridden).not.toContain("text-warning");
  });
});
