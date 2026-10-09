// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import {
  requiredScopesForAgent,
  MAX_CONNECTIONS_PER_INTEGRATION,
} from "@appstrate/core/integration";
import {
  canApplyConnectionSet,
  checkedConnectionIds,
  type ConnectionSet,
  displayedConnectionIds,
  placeCreatedConnection,
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
 *                 nothing is persisted until the form is. `null` = inherit.
 *
 * In both, `[]` is "no connection", offered only when the agent does not require the integration.
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
   * Version selector for the readiness verdict (#770). A non-`draft` value
   * pins the per-integration resolution + run-blocking flag to that published
   * manifest so the run-options modal matches the run. Omitted → draft.
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
  // client (else the connect 403s); api_key/basic/custom always can. Without
  // this the "add connection" entries offered a flow doomed to 403.
  const connectable = connectableAuthKeys(manifest, authStatuses);
  // When the actor's connections sit on another auth, only the agent's own auth fixes it.
  const requiredAuthKey = entry?.resolution.required_auth_key ?? null;
  const authKeys = Object.keys(auths).filter(
    (k) => connectable.has(k) && (requiredAuthKey === null || k === requiredAuthKey),
  );
  // The whole verdict (cascade + scope diff) is computed server-side; a pin
  // write or scope upgrade invalidates it so the dropdown re-resolves.
  const refresh = () => invalidateIntegrationQueries(qc);

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
  const { lockedConnectionIds, lockedBy, byDefault, softDefaultIds, emptyPickerPrompt } =
    describeResolution(resolution);

  const byId = (id: string): IntegrationCandidate | undefined =>
    candidates.find((c) => c.id === id);
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

  const explicitIds: ConnectionSet = overrideMode ? persistence.value : memberPinnedConnectionIds;
  const pickedNone = explicitIds?.length === 0;
  const boundIds = displayedConnectionIds({
    overrideMode,
    explicitIds,
    resolvedIds: resolvedConnectionIds,
  });
  // The set in play, named whole: the actor's own pick, else (pin mode) a soft
  // space default — a member of either that is no candidate blocks the run.
  const fromDefault = !overrideMode && explicitIds === null && softDefaultIds.length > 0;
  const storedIds = fromDefault ? softDefaultIds : (explicitIds ?? []);
  const unavailableIds = unavailableConnectionIds(storedIds, candidateIds);
  const dirty = draft !== null;
  const checkedIds = checkedConnectionIds({
    draft,
    explicitIds,
    resolvedIds: resolvedConnectionIds,
    candidateIds,
  });
  const atCap = checkedIds.length >= MAX_CONNECTIONS_PER_INTEGRATION;
  const oneClick = candidates.length === 1;

  const toConns = (ids: string[]) => ids.map(byId).filter((c): c is IntegrationCandidate => !!c);
  // The trigger reflects the bound set, never the uncommitted draft.
  const displayConns = toConns(boundIds);
  const checkedConns = toConns(checkedIds);
  // Warnings judge the set "Valider" would write, not the bound one.
  const verdictConns = dirty ? checkedConns : displayConns;
  const underScopedConns = verdictConns.filter((c) => c.missing_scopes.length > 0);
  const deadConns = verdictConns.filter((c) => c.needs_reconnection);
  const hasCandidates = candidates.length > 0;
  // Every entry that writes waits for the write in flight.
  const busy = upsertPin.isPending || deletePin.isPending;
  const canApply = canApplyConnectionSet(checkedConns, explicitIds, dirty) && !busy;

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
      // Only a pin write moves the server's verdict; an override is a form value.
      await refresh();
    }
    setDraft(null);
    return true;
  };

  const toggle = (connectionId: string) => setDraft(toggleCapped(checkedIds, connectionId));

  const triggerConnect = async (authKey: string, opts?: { connectionId?: string }) => {
    if (!auths[authKey]) return;
    // Every auth type goes through the hosted connect portal (issue #769) — the
    // popup opens the connect_url, which dispatches to the OAuth screen or the
    // hosted credential form server-side. We snapshot the accessible set first
    // so we can identify the just-created connection afterwards (the popup
    // can't return its id, and a cancelled popup adds nothing, leaving the
    // prior resolution intact). On a renew (connectionId supplied) the backend
    // UPDATEs in place and the snapshot diff is empty — we skip the select step.
    const before = new Set(candidates.map((c) => c.id));
    const isRenew = !!opts?.connectionId;
    // Forward the agent's per-tool inferred scopes so consent asks for what THIS
    // agent needs — not just the integration's manifest defaults (the
    // integration detail page is the surface that connects at defaults).
    // Non-OAuth auths resolve to an empty set and connect at their fixed creds.
    const scopes = requiredScopesForAgent({ manifest, authKey, agentTools, agentScopes });
    const settled = await openPopup({
      packageId: integrationId,
      authKey,
      ...(scopes.length ? { scopes } : {}),
      // Account picker is noise on a renew — the user is re-authorising the
      // existing identity, not picking a new one. Force-pick stays on fresh
      // connects so "Add another" actually offers a different account.
      ...(isRenew ? {} : { forceAccountSelect: true }),
      ...(opts?.connectionId ? { connectionId: opts.connectionId } : {}),
    });
    // A settled popup has refetched the readiness verdict: read it, never ask again.
    if (!settled || isRenew) return;
    let added: IntegrationCandidate | undefined;
    try {
      added = readResolution()?.candidates.find((c) => !before.has(c.id));
    } catch (err) {
      toastError(err);
      return;
    }
    if (!added) return;
    const placed = placeCreatedConnection({
      explicitIds,
      checkedIds,
      createdId: added.id,
    });
    if ("persist" in placed) {
      await persist(placed.persist);
      return;
    }
    // The menu closed on the connect click; reopen it on the new tick so "Valider" is at hand.
    setDraft(placed.draft);
    setOpen(true);
  };

  // A settled popup has already refetched the active integration queries.
  const upgradeScopes = (conn: IntegrationCandidate) =>
    openPopup({
      packageId: integrationId,
      authKey: conn.auth_key,
      scopes: conn.missing_scopes,
      connectionId: conn.id,
    });

  return {
    // Verdict
    runBlocking,
    required,
    candidates,
    candidateIds,
    resolvedConnectionIds,
    canAddConnection,
    lockedConnectionIds,
    lockedBy,
    byDefault,
    softDefaultIds,
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
    pickedNone,
    fromDefault,
    storedIds,
    unavailableIds,
    checkedIds,
    atCap,
    oneClick,
    displayConns,
    underScopedConns,
    deadConns,
    busy,
    canApply,
    // Labels shared by several components
    ownerLabel,
    setLabel,
    // Menu + actions
    open,
    setOpen,
    onOpenChange,
    oauthPending,
    persist,
    toggle,
    triggerConnect,
    upgradeScopes,
  };
}
