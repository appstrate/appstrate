// SPDX-License-Identifier: Apache-2.0

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
import { describeResolution } from "./integration-run-readiness";
import { scopeLabels } from "./scope-labels";
import {
  MAX_CONNECTIONS_PER_INTEGRATION,
  requiredScopesForAgent,
  resolveScopeToolSelection,
} from "@appstrate/core/integration";
import {
  connectionSetToSave,
  type ConnectionSet,
  imposedThenAdded,
  keepAvailable,
  placeCreatedConnection,
  shownConnectionPick,
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
 * integration). A lock (admin pin, enforced org default) always binds whole: nothing chosen
 * removes a member of it. Closed, it renders read-only: a member pin is masked, an override
 * within it is a no-op and one reaching outside it is refused (`override_outranked`). Open to
 * additions, the pick holds the additions only, never a locked id: `[]` (and, for the member's
 * pin, no pin) is "no addition".
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

/** One thing wrong with a set, said on its own line (with its way out, in the modal). */
export type PickerProblem =
  | { kind: "unavailable"; count: number; fromDefault: boolean }
  | { kind: "imposedUnavailable"; count: number }
  | { kind: "tooLarge" }
  | { kind: "dead"; conn: IntegrationCandidate }
  | { kind: "underScoped"; conn: IntegrationCandidate };

/** What the connections cell reads, before any edit. */
type PickerSummary =
  | {
      kind: "set";
      imposed: IntegrationCandidate[];
      chosen: IntegrationCandidate[];
      unavailable: number;
    }
  | { kind: "none" }
  | { kind: "inherit"; conns: IntegrationCandidate[] }
  | { kind: "choose" }
  | { kind: "connect" };

/** The rules of `IntegrationConnectionPicker` and its modal; `null` until the verdict has loaded. */
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
  // Renew/upgrade need `integrations:connect`; adding is the server's `can_add_connection`
  // (includes it): here the grant only tells a role refusal from the admin's block policy.
  const canConnect = usePermissions().can("integrations:connect");
  const integrationPath = packageDetailPath("integration", integrationId);
  const canOpenIntegration = useCanReach()(integrationPath);

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
  const { lockedConnectionIds, lockedBy, additionsAllowed, softDefaultIds, emptyPickerPrompt } =
    describeResolution(resolution);
  // Open to additions, the locked set always binds and the pick only adds to it: it is kept out
  // of the pick, of the ticks and of every write. Closed (or no lock), nothing is imposed here.
  const imposedIds = additionsAllowed ? lockedConnectionIds : [];
  const notImposed = (ids: string[]) => ids.filter((id) => !imposedIds.includes(id));
  const additionCap = MAX_CONNECTIONS_PER_INTEGRATION - imposedIds.length;
  const closedLock = lockedBy !== null && !additionsAllowed;

  const candidateIds = candidates.map((c) => c.id);
  const byId = (id: string): IntegrationCandidate | undefined =>
    candidates.find((c) => c.id === id);
  // Kept to the candidates: a member the user cannot see is said apart, as unavailable.
  const conns = (ids: string[]) => keepAvailable(ids, candidateIds).map((id) => byId(id)!);
  const missingScopeLabels = (c: IntegrationCandidate) =>
    scopeLabels(manifest, c.auth_key, c.missing_scopes);
  const connectsWithAgentScopes = (authKey: string) =>
    auths[authKey]?.type === "oauth2" && requiredScopesFor(authKey).length > 0;
  const ownerLabel = (c: IntegrationCandidate): string =>
    c.is_own
      ? t("detail.integrationMemberPicker.byYou")
      : (c.owner_name ?? t("detail.integrationMemberPicker.ownerUnknown"));

  // What a tick can choose: every candidate, the imposed ones aside.
  const addableIds = notImposed(candidateIds);
  // The list shows the imposed connections first, in their order, then the others as ranked.
  const listedCandidates = [
    ...imposedIds.flatMap((id) => byId(id) ?? []),
    ...candidates.filter((c) => !imposedIds.includes(c.id)),
  ];

  // An imposed id stored in a pick (written before the lock opened) adds nothing: it is dropped.
  const storedIds: ConnectionSet = overrideMode ? persistence.value : memberPinnedConnectionIds;
  const explicitIds: ConnectionSet = storedIds === null ? null : notImposed(storedIds);
  // Open: the imposed set, then the additions (an unset override inherits the member's pin's).
  const shownIds = additionsAllowed
    ? imposedThenAdded(
        imposedIds,
        explicitIds ?? (overrideMode ? notImposed(memberPinnedConnectionIds ?? []) : []),
      )
    : (shownConnectionPick({
        explicitIds,
        memberPinIds: memberPinnedConnectionIds,
        softDefaultIds,
        resolvedIds: resolvedConnectionIds,
      }) ?? []);
  const shownAddedIds = notImposed(shownIds);
  const pickedNone = explicitIds?.length === 0;
  const fromDefault = explicitIds === null && softDefaultIds.length > 0;
  // A shown member that is no candidate blocks the run: an imposed one is the admin's to fix.
  const unavailableIds = unavailableConnectionIds(shownAddedIds, candidateIds);
  const imposedUnavailableIds = unavailableConnectionIds(imposedIds, candidateIds);

  /**
   * What is wrong with `addedIds` once bound beside the imposed set: members gone, too many, dead
   * or under-scoped ones (kept to the candidates: one the user cannot see cannot be fixed here).
   */
  const problemsOf = (addedIds: string[]): PickerProblem[] => {
    const gone = unavailableConnectionIds(addedIds, candidateIds);
    const bound = conns(addedIds);
    return [
      ...(gone.length > 0
        ? [{ kind: "unavailable" as const, count: gone.length, fromDefault }]
        : []),
      ...(imposedUnavailableIds.length > 0
        ? [{ kind: "imposedUnavailable" as const, count: imposedUnavailableIds.length }]
        : []),
      // The server refuses a union over the cap (`connection_set_too_large`) rather than cut it.
      ...(imposedIds.length + addedIds.length > MAX_CONNECTIONS_PER_INTEGRATION
        ? [{ kind: "tooLarge" as const }]
        : []),
      ...bound.filter((c) => c.needs_reconnection).map((conn) => ({ kind: "dead" as const, conn })),
      ...bound
        .filter((c) => c.missing_scopes.length > 0)
        .map((conn) => ({ kind: "underScoped" as const, conn })),
    ];
  };
  // The cell's lines: an imposed connection only through the imposed-unavailable line, the rest
  // being the admin's to fix and said by the amber state.
  const problems = problemsOf(shownAddedIds);

  // Turns the cell amber. The server's `run_blocking` judges the cascade but not a set
  // override, judged here on what it binds. Under a closed lock the lock binds whatever the
  // override says, so the cascade's verdict stands (an outranked override is said apart).
  const shownConns = conns(shownIds);
  const gatesRun =
    overrideMode && explicitIds !== null && !closedLock
      ? shownConns.some((c) => c.missing_scopes.length > 0 || c.needs_reconnection) ||
        unavailableIds.length > 0 ||
        imposedUnavailableIds.length > 0 ||
        shownIds.length > MAX_CONNECTIONS_PER_INTEGRATION ||
        (pickedNone && required && imposedIds.length === 0)
      : runBlocking;

  // What the cascade gives while nothing is chosen (the verdict ignores an override).
  const inheritedConns = conns(resolvedConnectionIds);
  const summary: PickerSummary = additionsAllowed
    ? {
        kind: "set",
        imposed: conns(imposedIds),
        chosen: conns(shownAddedIds),
        unavailable: imposedUnavailableIds.length + unavailableIds.length,
      }
    : unavailableIds.length > 0 || (explicitIds !== null && explicitIds.length > 0)
      ? { kind: "set", imposed: [], chosen: conns(shownIds), unavailable: unavailableIds.length }
      : pickedNone
        ? { kind: "none" }
        : overrideMode || inheritedConns.length > 0
          ? { kind: "inherit", conns: inheritedConns }
          : { kind: emptyPickerPrompt === "choose" ? "choose" : "connect" };

  // The modal opens on what binds, the imposed set aside; « Enregistrer » writes the ticks.
  const initialTicks = keepAvailable(shownAddedIds, addableIds);
  // Unticking every addition under an imposed set is « no addition »: no pin for the member,
  // `[]` for an override. Elsewhere an empty tick is no answer: « Aucune connexion » is.
  const emptyValue: ConnectionSet | undefined =
    imposedIds.length > 0 ? (overrideMode ? [] : null) : undefined;
  const busy = upsertPin.isPending || deletePin.isPending;
  /** What « Enregistrer » writes for `ticked`, `undefined` while it would write nothing. */
  const saveValue = (ticked: readonly string[]): ConnectionSet | undefined =>
    connectionSetToSave({ ticked, initial: initialTicks, stored: explicitIds, emptyValue });
  // « Revenir au choix par défaut » clears a choice; under an imposed set the member's own pin
  // is already what an empty tick clears.
  const offersDefault = explicitIds !== null && (!additionsAllowed || overrideMode);
  // Nothing removes an imposed connection, and a required integration takes one.
  const offersNone = !required && lockedBy === null && !pickedNone;

  // `null` clears the pick, `[]` stores "no connection" (under an open lock, no addition).
  // False = refused; the mutation toasted why.
  const persist = async (connectionIds: ConnectionSet): Promise<boolean> => {
    if (overrideMode) {
      persistence.onChange(connectionIds);
      return true;
    }
    try {
      if (connectionIds !== null) {
        await upsertPin.mutateAsync({ agentPackageId, integrationId, connectionIds });
      } else {
        await deletePin.mutateAsync({ agentPackageId, integrationId });
      }
    } catch {
      return false;
    }
    // A pin write moves the server's verdict; an override is a form value and moves nothing.
    await invalidateIntegrationQueries(qc);
    return true;
  };

  /**
   * Connects a NEW connection, then writes `ticked` (the modal's ticks, else what binds) with it
   * added, in place of `replacing`. True once that write landed.
   * Never sends a `connection_id`: the server would union scopes into it, widening every agent bound to it.
   */
  const triggerConnect = async (
    authKey: string,
    opts: { replacing?: string; ticked?: readonly string[] } = {},
  ): Promise<boolean> => {
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
    if (!settled) return false;
    let refetchedIds: string[];
    try {
      refetchedIds = (readResolution()?.candidates ?? []).map((c) => c.id);
    } catch (err) {
      toastError(err);
      return false;
    }
    const createdId = refetchedIds.find((id) => !before.has(id));
    if (!createdId) return false;
    const placed = placeCreatedConnection({
      // The set when the connect started (the refetched cascade may already count the new one);
      // under an open lock its additions, the new one being one more.
      boundIds: keepAvailable([...(opts.ticked ?? shownAddedIds)], refetchedIds),
      createdId,
      max: additionCap,
      ...(opts.replacing ? { replacing: opts.replacing } : {}),
    });
    if (!placed.includes(createdId)) {
      toast.warning(
        t("detail.integrationMemberPicker.maxReached", { max: MAX_CONNECTIONS_PER_INTEGRATION }),
      );
      return false;
    }
    return persist(placed);
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
  // Only the owner renews or upgrades: a foreign shared connection's tokens are someone else's.
  const canFixInPlace = (conn: IntegrationCandidate) =>
    canConnect && conn.is_own && auths[conn.auth_key]?.type === "oauth2";

  return {
    gatesRun,
    required,
    candidates,
    candidateIds,
    canAddConnection,
    lockedConnectionIds,
    lockedBy,
    closedLock,
    additionsAllowed,
    imposedIds,
    additionCap,
    listedCandidates,
    emptyPickerPrompt,
    canConnect,
    integrationPath,
    canOpenIntegration,
    overrideMode,
    auths,
    authKeys,
    explicitIds,
    pickedNone,
    summary,
    problems,
    problemsOf,
    unavailableIds,
    initialTicks,
    saveValue,
    offersDefault,
    offersNone,
    busy,
    ownerLabel,
    manifest,
    missingScopeLabels,
    connectsWithAgentScopes,
    canFixInPlace,
    oauthPending,
    persist,
    triggerConnect,
    renewConnection,
    upgradeScopes,
  };
}
