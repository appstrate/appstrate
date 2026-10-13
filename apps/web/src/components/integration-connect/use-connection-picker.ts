// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
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
import { useHostedConnectPopup } from "./use-integration-oauth-popup";
import { connectableAuthKeys } from "./connectable-auth-keys";
import { describeResolution } from "./integration-run-readiness";
import { scopeLabels } from "./scope-labels";
import {
  requiredScopesForAgent,
  resolveScopeToolSelection,
  MAX_CONNECTIONS_PER_INTEGRATION,
} from "@appstrate/core/integration";
import {
  canApplyConnectionSet,
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
 * How the picker persists the actor's pick:
 *
 *  - `pin`      — writes a member `integration_pin` (agent page), the
 *                 agent-wide default for this member across every run.
 *  - `override` — controlled form value (schedule editor, per-run modal);
 *                 nothing is persisted until the form is. `null` = unset.
 *                 `onChange` also fires once a connect popup settles, long after
 *                 the render that passed it: it must apply the pick to the value
 *                 the form holds then.
 *
 * In both, an explicit pick displays itself and an unset pick displays what the layer below
 * binds, marked as the default; `[]` at either layer is "no connection", offered only when the
 * agent does not require the integration.
 *
 * Locks (admin pin, enforced org default) render read-only in both modes: a
 * member pin loses to them, and an override naming a connection outside the
 * locked set is refused (`override_outranked`). A stored override within the
 * locked set narrows it and is shown as what binds; one reaching outside it is
 * offered its only fix, being cleared. "No connection" narrows any lock, so an
 * override may still pick it under one.
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
  /**
   * Version selector for the readiness verdict: the per-integration resolution, `required` and
   * the run-blocking flag are those of that definition, so a launch form matches what it runs.
   * Omitted → the server's default: the draft for a caller who can write the package, else the
   * latest published version.
   */
  version?: string;
}

/**
 * What the picker takes from outside React. `openPopup` defaults to the hosted
 * connect popup; tests pass one honouring its contract (resolves `true` once
 * the active integration queries were refetched), since the real one needs a browser.
 */
export interface ConnectionPickerDeps {
  openPopup?: ReturnType<typeof useHostedConnectPopup>["openPopup"];
}

export type ConnectionPicker = NonNullable<ReturnType<typeof useConnectionPicker>>;

/**
 * State and actions of `IntegrationConnectionPicker`: the readiness
 * verdict, the uncommitted draft, the pin/override write and the connect
 * orchestration. `null` until the verdict has loaded.
 */
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
  // Same bulk query as the launch badge, selected per-integration.
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
  // Renewing and upgrading open a connect session (`integrations:connect`).
  // Adding is the server's `can_add_connection`, which already includes it:
  // here the grant only tells a role refusal from the admin's block policy.
  const canConnect = usePermissions().can("integrations:connect");
  const integrationPath = packageDetailPath("integration", integrationId);
  const canOpenIntegration = useCanReach()(integrationPath);

  const overrideMode = persistence.mode === "override";
  const auths = manifest.auths ?? {};
  // Only auths the actor can actually connect: oauth2 needs an admin OAuth
  // client (else the connect 403s); api_key/basic/custom always can.
  const connectable = connectableAuthKeys(manifest, authStatuses);
  // When the actor's connections sit on another auth, only the agent's own auth fixes it.
  const requiredAuthKey = entry?.resolution.warning?.required_auth_key ?? null;
  const authKeys = Object.keys(auths).filter(
    (k) => connectable.has(k) && (requiredAuthKey === null || k === requiredAuthKey),
  );
  // The server's scope selection, so a connect asks for what the run then requires.
  const scopeTools = resolveScopeToolSelection(agentTools, manifest);
  const requiredScopesFor = (authKey: string) =>
    requiredScopesForAgent({ manifest, authKey, agentTools: scopeTools, agentScopes });

  // No picker until the entry is in: `required` is unknown before, and "no connection" must not
  // be offered for an integration the agent requires.
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
  // A fresh connect requests the agent's scopes; only an oauth2 auth makes that worth saying.
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

  // The explicit layer: what `persist` and the reset entry act on.
  const explicitIds: ConnectionSet = overrideMode ? persistence.value : memberPinnedConnectionIds;
  // The one pick everything shown derives from, the trigger and the menu alike.
  const shownPick = shownConnectionPick({
    explicitIds,
    memberPinIds: memberPinnedConnectionIds,
    softDefaultIds,
    resolvedIds: resolvedConnectionIds,
  });
  const shownIds = shownPick ?? [];
  // An unset pick shows the layer below, marked as the default.
  const shownAsDefault = explicitIds === null && shownPick !== null;
  const fromDefault = explicitIds === null && softDefaultIds.length > 0;
  // A shown member that is no candidate blocks the run: the set is named whole.
  const unavailableIds = unavailableConnectionIds(shownIds, candidateIds);
  // A set kept to the candidates (a tick the user cannot see is one they cannot remove), with
  // what gates a run on it.
  const judge = (ids: string[]) => {
    const conns = keepAvailable(ids, candidateIds).map((id) => byId(id)!);
    return {
      conns,
      underScoped: conns.filter((c) => c.missing_scopes.length > 0),
      dead: conns.filter((c) => c.needs_reconnection),
    };
  };
  // The trigger shows, and is judged on, the shown pick — never the uncommitted draft.
  const shown = judge(shownIds);
  // Whether the pick gates a run — what turns the picker amber. The server's `run_blocking` (same
  // verdict as the launch badge and the kickoff 409) judges the cascade: a member pin, and what
  // an unset override shows. It does not know a set override, judged here on the pick itself: an
  // under-scoped, dead or unavailable member, or "no connection" for a required integration.
  const gatesRun =
    overrideMode && explicitIds !== null
      ? shown.underScoped.length > 0 ||
        shown.dead.length > 0 ||
        unavailableIds.length > 0 ||
        (explicitIds.length === 0 && required)
      : runBlocking;
  // The ticked rows and the warnings under the picker follow the set "Valider" would write: the
  // same one until a tick moves it.
  const checked = draft === null ? shown : judge(draft);
  const checkedIds = checked.conns.map((c) => c.id);
  const atCap = checkedIds.length >= MAX_CONNECTIONS_PER_INTEGRATION;
  const oneClick = candidates.length === 1;
  const hasCandidates = candidates.length > 0;
  // Every entry that writes waits for the write in flight.
  const busy = upsertPin.isPending || deletePin.isPending;
  const canApply = canApplyConnectionSet(checked.conns, explicitIds, draft !== null) && !busy;

  // `null` clears the pick, `[]` stores "no connection". False = refused; the mutation toasted why.
  const persist = async (connectionIds: ConnectionSet): Promise<boolean> => {
    if (overrideMode) persistence.onChange(connectionIds);
    else {
      try {
        if (connectionIds !== null) {
          await upsertPin.mutateAsync({ agentPackageId, integrationId, connectionIds });
        } else {
          await deletePin.mutateAsync({ agentPackageId, integrationId });
        }
      } catch {
        return false;
      }
      // The verdict (cascade + scope diff) is the server's: a pin write moves it, so the picker
      // reads it again. An override is a form value and moves nothing.
      await invalidateIntegrationQueries(qc);
    }
    setDraft(null);
    return true;
  };

  const toggle = (connectionId: string) => setDraft(toggleCapped(checkedIds, connectionId));

  /**
   * Connects a NEW connection with the agent's scopes, then writes the shown pick with it added —
   * in the place of `replacing` (an under-scoped member) when given. Never sends a
   * `connection_id`: the server would union the scopes into that connection, widening every
   * agent bound to it.
   */
  const triggerConnect = async (authKey: string, opts?: { replacing?: string }) => {
    // The popup cannot return the new id: it is the candidate this snapshot lacks.
    const before = new Set(candidateIds);
    // Consent asks for what THIS agent needs on top of the auth's `default_scopes`, which the
    // server always requests. Non-OAuth auths connect at their fixed credentials.
    const scopes = requiredScopesFor(authKey);
    const settled = await openPopup({
      packageId: integrationId,
      authKey,
      ...(scopes.length ? { scopes } : {}),
      // Force the IdP's account picker so "Add another" can offer a different account.
      forceAccountSelect: true,
    });
    // A settled popup has refetched the readiness verdict: read it, never ask again.
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
      // The pick shown when the connect started (the refetched cascade may already count the
      // created connection), without the draft, kept to the ids the refetch still offers.
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

  // The two in-place writes. A settled popup has already refetched the active integration queries.
  // Renewing re-consents what the connection holds: it sends no scopes, so it widens nothing.
  const renewConnection = (conn: IntegrationCandidate) =>
    openPopup({ packageId: integrationId, authKey: conn.auth_key, connectionId: conn.id });
  // Upgrading widens it for every agent bound to it — only ever after a confirmation.
  const upgradeScopes = (conn: IntegrationCandidate) =>
    openPopup({
      packageId: integrationId,
      authKey: conn.auth_key,
      scopes: conn.missing_scopes,
      connectionId: conn.id,
    });

  return {
    // Verdict
    gatesRun,
    required,
    candidates,
    candidateIds,
    canAddConnection,
    lockedConnectionIds,
    lockedBy,
    emptyPickerPrompt,
    // Actor
    canConnect,
    integrationPath,
    canOpenIntegration,
    overrideMode,
    auths,
    authKeys,
    hasCandidates,
    // Sets
    explicitIds,
    shownPick,
    shownIds,
    shownAsDefault,
    fromDefault,
    unavailableIds,
    checkedIds,
    atCap,
    oneClick,
    displayConns: shown.conns,
    underScopedConns: checked.underScoped,
    deadConns: checked.dead,
    busy,
    canApply,
    // Labels shared by several components
    ownerLabel,
    setLabel,
    manifest,
    missingScopeLabels,
    connectsWithAgentScopes,
    // Menu + actions
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
