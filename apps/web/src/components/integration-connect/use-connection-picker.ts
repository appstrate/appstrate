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
import { scopeFit, scopeLabels, sortByScopeFit } from "./connection-scope-fit";
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
  // client (else the connect 403s); api_key/basic/custom always can. Without
  // this the "add connection" entries offered a flow doomed to 403.
  const connectable = connectableAuthKeys(manifest, authStatuses);
  // When the actor's connections sit on another auth, only the agent's own auth fixes it.
  const requiredAuthKey = entry?.resolution.warning?.required_auth_key ?? null;
  const authKeys = Object.keys(auths).filter(
    (k) => connectable.has(k) && (requiredAuthKey === null || k === requiredAuthKey),
  );
  // The whole verdict (cascade + scope diff) is computed server-side; a pin
  // write or scope upgrade invalidates it so the dropdown re-resolves.
  const refresh = () => invalidateIntegrationQueries(qc);
  const requiredScopesFor = (authKey: string) =>
    requiredScopesForAgent({ manifest, authKey, agentTools, agentScopes });

  // No picker until the entry is in: `required` is unknown before, and "no connection" must not
  // be offered for an integration the agent requires.
  if (isPending || !entry) return null;

  const { resolution, run_blocking: runBlocking, required } = entry;
  const {
    candidates: unranked,
    resolved_connection_ids: resolvedConnectionIds,
    member_pinned_connection_ids: memberPinnedConnectionIds,
    can_add_connection: canAddConnection,
  } = resolution;
  const { lockedConnectionIds, lockedBy, byDefault, softDefaultIds, emptyPickerPrompt } =
    describeResolution(resolution);

  const fits = new Map(
    unranked.map((c) => [
      c.id,
      scopeFit({
        manifest,
        authKey: c.auth_key,
        granted: c.scopes_granted,
        missing: c.missing_scopes,
        required: requiredScopesFor(c.auth_key),
      }),
    ]),
  );
  const scopeFitOf = (c: IntegrationCandidate) => fits.get(c.id) ?? "unjudged";
  // Compatible first, least privilege leading.
  const candidates = sortByScopeFit(unranked, scopeFitOf);
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

  /**
   * A NEW connection with the agent's scopes, which takes the place of `replacing` (an
   * under-scoped member) in the pick. Never sends a `connection_id`: the server would union the
   * scopes into that connection, widening every agent bound to it.
   */
  const triggerConnect = async (authKey: string, opts?: { replacing?: string }) => {
    if (!auths[authKey]) return;
    // The popup cannot return the new id: it is the candidate this snapshot lacks.
    const before = new Set(candidates.map((c) => c.id));
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
      ...(opts?.replacing ? { replacing: opts.replacing } : {}),
    });
    if ("persist" in placed) {
      await persist(placed.persist);
      return;
    }
    // The menu closed on the connect click; reopen it on the new tick so "Valider" is at hand.
    setDraft(placed.draft);
    setOpen(true);
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
    scopeFitOf,
    manifest,
    missingScopeLabels,
    connectsWithAgentScopes,
    // Menu + actions
    open,
    setOpen,
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
