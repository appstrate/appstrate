// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useSettingDraft } from "../../hooks/use-setting-draft";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  invalidateIntegrationQueries,
  useIntegrationReadinessEntry,
  useReadIntegrationResolution,
  type IntegrationAuthStatus,
  type IntegrationCandidate,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";
import {
  useUpsertMemberIntegrationPin,
  useDeleteMemberIntegrationPin,
} from "../../hooks/use-member-integration-pins";
import { useHostedConnectPopup } from "./use-hosted-connect-popup";
import { connectableAuthKeys } from "./connectable-auth-keys";
import { describeResolution, unboundLabel } from "./integration-run-readiness";
import { scopeLabels } from "./scope-labels";
import {
  MAX_CONNECTIONS_PER_INTEGRATION,
  requiredScopesForAgent,
  resolveScopeToolSelection,
} from "@appstrate/core/integration";
import {
  canApplyConnectionSet,
  checkedConnectionIds,
  type ConnectionSet,
  keepAvailable,
  placeCreatedConnection,
  shownConnectionPick,
  toggleCapped,
  unavailableConnectionIds,
} from "../../lib/connection-set";
import { packageDetailPath } from "../../lib/package-paths";
import { toastError } from "../../lib/mutation-error";
import { usePermissions } from "../../hooks/use-permissions";
import { useCanReach } from "../../hooks/use-can-reach";

/**
 * - `pin`: writes the member `integration_pin` (agent-wide default for this member).
 * - `override`: controlled form value, `null` = unset. `onChange` also fires after a connect
 *   popup settles, long after the render that passed it: apply the pick to the value the form
 *   holds then.
 *
 * Unset is "Hériter"; `[]` is "no connection" (offered only if the agent does not require the
 * integration). Locks (admin pin, enforced org default) render read-only: a member pin loses to
 * them and an override outside the locked set is refused (`override_outranked`); "no connection"
 * narrows any lock, so it stays pickable.
 */
export type ConnectionPickerPersistence =
  | { mode: "pin" }
  | { mode: "override"; value: ConnectionSet; onChange: (connectionIds: ConnectionSet) => void };

export interface ConnectionPickerOptions {
  integrationId: string;
  agentPackageId: string;
  manifest: IntegrationManifestView;
  authStatuses: IntegrationAuthStatus[];
  agentTools: string[] | "*" | undefined;
  agentScopes: string[] | undefined;
  persistence: ConnectionPickerPersistence;
  /** Version the readiness verdict is read for, so a launch form matches what it runs. Omitted: the server's default. */
  version?: string;
}

/** `openPopup` is injectable for tests (must resolve `true` once active integration queries refetched). */
export interface ConnectionPickerDeps {
  openPopup?: ReturnType<typeof useHostedConnectPopup>["openPopup"];
}

export type ConnectionPicker = NonNullable<ReturnType<typeof useConnectionPicker>>;

/** State and actions of `IntegrationConnectionPicker`; `null` until the verdict has loaded. */
export function useConnectionPicker(
  {
    integrationId,
    agentPackageId,
    manifest,
    authStatuses,
    agentTools,
    agentScopes,
    persistence,
    version,
  }: ConnectionPickerOptions,
  deps: ConnectionPickerDeps = {},
) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: entry, isPending } = useIntegrationReadinessEntry(
    integrationId,
    agentPackageId,
    version,
  );
  const readResolution = useReadIntegrationResolution(integrationId, agentPackageId, version);
  const upsertPin = useUpsertMemberIntegrationPin();
  const deletePin = useDeleteMemberIntegrationPin();
  const hostedPopup = useHostedConnectPopup();
  const openPopup = deps.openPopup ?? hostedPopup.openPopup;
  const oauthPending = hostedPopup.isPending;
  const qc = useQueryClient();
  // Uncommitted ticks (`null` = untouched); dropped when the menu closes.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [upgradeTargetId, setUpgradeTargetId] = useState<string | null>(null);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setDraft(null);
  };
  // Renew/upgrade need `integrations:connect`; adding is the server's `can_add_connection`
  // (includes it): here the grant only tells a role refusal from the admin's block policy.
  const canConnect = usePermissions().can("integrations:connect");
  const integrationPath = packageDetailPath("integration", integrationId);
  const canOpenIntegration = useCanReach()(integrationPath);

  const memberDraft = useSettingDraft<ConnectionSet>(
    entry?.resolution.member_pinned_connection_ids ?? null,
  );
  const overrideMode = persistence.mode === "override";
  const auths = manifest.auths ?? {};
  const connectable = connectableAuthKeys(manifest, authStatuses);
  // When the actor's connections sit on another auth, only the agent's own auth fixes it.
  const requiredAuthKey = entry?.resolution.warning?.required_auth_key ?? null;
  const authKeys = Object.keys(auths).filter(
    (k) => connectable.has(k) && (requiredAuthKey === null || k === requiredAuthKey),
  );
  const scopeTools = resolveScopeToolSelection(agentTools, manifest);
  const requiredScopesFor = (authKey: string) =>
    requiredScopesForAgent({ manifest, authKey, agentTools: scopeTools, agentScopes });

  // `required` is unknown before the entry: "no connection" must not be offered for a required one.
  if (isPending || !entry) return null;

  const { resolution, run_blocking: runBlocking, required } = entry;
  const {
    candidates,
    resolved_connection_ids: resolvedConnectionIds,
    member_pinned_connection_ids: memberPinnedConnectionIds,
    can_add_connection: canAddConnection,
  } = resolution;
  const { lockedConnectionIds, lockedBy, softDefaultIds, emptyPickerPrompt } =
    describeResolution(resolution);

  const byId = (id: string): IntegrationCandidate | undefined =>
    candidates.find((c) => c.id === id);
  const missingScopeLabels = (c: IntegrationCandidate) =>
    scopeLabels(manifest, c.auth_key, c.missing_scopes);
  const connectsWithAgentScopes = (authKey: string) =>
    auths[authKey]?.type === "oauth2" && requiredScopesFor(authKey).length > 0;
  const ownerLabel = (c: IntegrationCandidate): string =>
    c.is_own
      ? t("detail.integrationMemberPicker.byYou")
      : (c.owner_name ?? t("detail.integrationMemberPicker.ownerUnknown"));

  const candidateIds = candidates.map((c) => c.id);
  const setLabel = (ids: string[], unavailable: string[]): string =>
    unavailable.length > 0
      ? `${t("detail.integrationMemberPicker.selectedCount", { count: ids.length })} · ${t(
          "detail.integrationMemberPicker.unavailableCount",
          { count: unavailable.length },
        )}`
      : ids.map((id) => byId(id)!.label).join(" · ");

  const explicitIds: ConnectionSet = overrideMode ? persistence.value : memberDraft.value;
  const shownPick = shownConnectionPick({
    explicitIds,
    memberPinIds: overrideMode ? memberPinnedConnectionIds : null,
    softDefaultIds:
      !overrideMode && memberDraft.dirty && explicitIds === null
        ? (resolution.org_default_connection_ids ?? [])
        : softDefaultIds,
    resolvedIds:
      !overrideMode && memberDraft.dirty && explicitIds === null ? [] : resolvedConnectionIds,
  });
  const shownIds = shownPick ?? [];
  const pickedNone = explicitIds?.length === 0;
  const fromDefault = explicitIds === null && softDefaultIds.length > 0;
  // A shown member that is no candidate blocks the run.
  const unavailableIds = unavailableConnectionIds(shownIds, candidateIds);
  // Kept to the candidates: a tick the user cannot see cannot be removed.
  const judge = (ids: string[]) => {
    const conns = keepAvailable(ids, candidateIds).map((id) => byId(id)!);
    return {
      conns,
      underScoped: conns.filter((c) => c.missing_scopes.length > 0),
      dead: conns.filter((c) => c.needs_reconnection),
    };
  };
  const shown = judge(shownIds);
  // Turns the picker amber. The server's `run_blocking` judges the cascade but not a set
  // override, judged here on the pick itself.
  const gatesRun =
    (overrideMode || memberDraft.dirty) && explicitIds !== null
      ? shown.underScoped.length > 0 ||
        shown.dead.length > 0 ||
        unavailableIds.length > 0 ||
        (pickedNone && required)
      : runBlocking;
  // Ticks are what is CHOSEN, never what the cascade would bind.
  const checkedIds = checkedConnectionIds({ draft, explicitIds, candidateIds });
  const ticked = judge(checkedIds);
  // Warnings judge what "Valider" would write once a tick moved, else the shown pick.
  const warned = draft === null ? shown : ticked;
  // What "Hériter" would bind: the verdict (it ignores an override); under a member pin the
  // verdict is the pin, so only the soft space default can be named.
  const orgDefaultIds = resolution.org_default_connection_ids ?? [];
  const inheritedConns =
    overrideMode || memberPinnedConnectionIds === null
      ? resolvedConnectionIds.map(byId).filter((c): c is IntegrationCandidate => !!c)
      : orgDefaultIds.map(byId).filter((c): c is IntegrationCandidate => !!c);
  const inheritedSource =
    overrideMode || memberPinnedConnectionIds === null
      ? resolution.source
      : orgDefaultIds.length > 0
        ? ("org_default" as const)
        : null;
  const inheritedUnbound = unboundLabel(resolution.warning);
  const oneClick = candidates.length === 1;
  const hasCandidates = candidates.length > 0;
  const busy = upsertPin.isPending || deletePin.isPending;
  const canApply = canApplyConnectionSet(ticked.conns, explicitIds, draft !== null) && !busy;

  // Choosing only edits the form. A member pin is persisted by the explicit Save bar.
  const persist = async (connectionIds: ConnectionSet): Promise<boolean> => {
    if (overrideMode) persistence.onChange(connectionIds);
    else memberDraft.set(connectionIds);
    setDraft(null);
    return true;
  };
  const saveMember = async () => {
    const sent = memberDraft.value;
    if (sent === null) await deletePin.mutateAsync({ agentPackageId, integrationId });
    else await upsertPin.mutateAsync({ agentPackageId, integrationId, connectionIds: sent });
    memberDraft.accept(sent);
    await invalidateIntegrationQueries(qc);
  };

  const toggle = (connectionId: string) => setDraft(toggleCapped(checkedIds, connectionId));

  /**
   * Connects a NEW connection, then writes the shown pick with it added (in place of `replacing`).
   * Never sends a `connection_id`: the server would union scopes into it, widening every agent bound to it.
   */
  const triggerConnect = async (authKey: string, opts?: { replacing?: string }) => {
    // The popup cannot return the new id: it is the candidate this snapshot lacks.
    const before = new Set(candidateIds);
    const scopes = requiredScopesFor(authKey);
    const settled = await openPopup({
      packageId: integrationId,
      authKey,
      ...(scopes.length ? { scopes } : {}),
      forceAccountSelect: true,
    });
    // A settled popup has refetched the verdict: read it, never ask again.
    if (!settled) return;
    let refetchedIds: string[];
    try {
      refetchedIds = (readResolution()?.candidates ?? []).map((c) => c.id);
    } catch (err) {
      toastError(err);
      return;
    }
    const createdId = refetchedIds.find((id) => !before.has(id));
    if (!createdId) return;
    const placed = placeCreatedConnection({
      // The pick shown when the connect started (the refetched cascade may already count the new one).
      boundIds: keepAvailable(shownIds, refetchedIds),
      createdId,
      ...(opts?.replacing ? { replacing: opts.replacing } : {}),
    });
    if (!placed.includes(createdId)) {
      toast.warning(
        t("detail.integrationMemberPicker.maxReached", { max: MAX_CONNECTIONS_PER_INTEGRATION }),
      );
      return;
    }
    await persist(placed);
  };

  // Renewing sends no scopes, so it widens nothing.
  const renewConnection = (conn: IntegrationCandidate) =>
    openPopup({ packageId: integrationId, authKey: conn.auth_key, connectionId: conn.id });
  // Upgrading widens it for every agent bound to it: only after a confirmation.
  const upgradeScopes = (conn: IntegrationCandidate) =>
    openPopup({
      packageId: integrationId,
      authKey: conn.auth_key,
      scopes: conn.missing_scopes,
      connectionId: conn.id,
    });

  return {
    memberDraft,
    saveMember,
    gatesRun,
    required,
    candidates,
    candidateIds,
    canAddConnection,
    lockedConnectionIds,
    lockedBy,
    emptyPickerPrompt,
    inheritedConns,
    inheritedSource,
    inheritedUnbound,
    canConnect,
    integrationPath,
    canOpenIntegration,
    overrideMode,
    auths,
    authKeys,
    hasCandidates,
    explicitIds,
    pickedNone,
    shownIds,
    fromDefault,
    unavailableIds,
    checkedIds,
    oneClick,
    displayConns: shown.conns,
    underScopedConns: warned.underScoped,
    deadConns: warned.dead,
    busy,
    canApply,
    ownerLabel,
    setLabel,
    manifest,
    missingScopeLabels,
    connectsWithAgentScopes,
    open,
    onOpenChange,
    oauthPending,
    persist,
    toggle,
    triggerConnect,
    renewConnection,
    upgradeScopes,
    upgradeTargetId,
    setUpgradeTargetId,
  };
}
