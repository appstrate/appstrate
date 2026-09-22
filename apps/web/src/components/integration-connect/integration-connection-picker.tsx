// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Loader2,
  Users,
  Check,
  Plus,
  Lock,
  ChevronDown,
  RefreshCw,
  Settings,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import {
  invalidateIntegrationQueries,
  useIntegrationAgentResolution,
  useIntegrationRunBlocking,
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
import {
  requiredScopesForAgent,
  labelsSharedBy,
  MAX_CONNECTIONS_PER_INTEGRATION,
} from "@appstrate/core/integration";
import { displayedConnectionIds, toggleCapped, EMPTY_CONNECTION_SET } from "./connection-set";
import { client } from "../../api/client";
import { packageDetailPath, splitPackageRef } from "../../lib/package-paths";
import { isVersioned } from "../../lib/version-selector";

/**
 * How the picker persists the actor's pick:
 *
 *  - `pin`      — writes a member `integration_pin` (agent page). Becomes the
 *                 agent-wide default for this member across every run. The
 *                 trigger reflects the server-resolved set.
 *  - `override` — controlled form value (schedule editor). Validating sets
 *                 `value` via `onChange`; nothing is persisted until the
 *                 schedule is saved, and the pick is scoped to THAT schedule
 *                 (`schedules.connection_overrides`, cascade layer 4 — below
 *                 admin pins, above member pins). Empty array = inherit.
 *
 * Either way the written value is the WHOLE set: a pin write replaces the
 * previous set, never merges into it.
 *
 * Locks (admin pin, enforced org default) apply identically in both modes:
 * they sit above the schedule override in the resolver cascade, so a locked
 * set would beat a schedule pick anyway — surfacing the lock here is
 * the honest signal that the override would be ignored.
 */
type ConnectionPickerPersistence =
  | { mode: "pin" }
  | { mode: "override"; value: string[]; onChange: (connectionIds: string[]) => void };

/**
 * Per-integration connection picker, rendered as a rich dropdown. Lists every
 * accessible connection (own + shared-with-org) with its name, auth type
 * (OAuth / API key …), and who created it, plus a reset entry and "add a
 * connection" entries (one per declared auth) that launch the connect flow
 * inline.
 *
 * A run binds 1..{@link MAX_CONNECTIONS_PER_INTEGRATION} connections per
 * integration, so the rows are checkboxes accumulating into a draft set that
 * the "Valider" entry writes in one go. The degenerate case is deliberately
 * frictionless: with a single accessible connection, clicking its row binds it
 * straight away, exactly as before.
 *
 * Single source of truth for "which connections?" UX — shared by the agent
 * page (member pins) and the schedule editor (per-schedule overrides) via the
 * `persistence` prop. The candidate list, scope/lock verdicts and the connect
 * orchestration (hosted connect portal popup) are identical across both; only
 * where the pick lands differs.
 */
// Module-level constant so the default prop is a stable reference across
// renders (a `{ mode: "pin" }` literal default would be a new object each
// render — react/no-object-type-as-default-prop).
const DEFAULT_PERSISTENCE: ConnectionPickerPersistence = { mode: "pin" };

export function IntegrationConnectionPicker({
  integrationId,
  agentPackageId,
  manifest,
  authStatuses,
  agentTools,
  agentScopes,
  persistence = DEFAULT_PERSISTENCE,
  version,
}: {
  integrationId: string;
  agentPackageId: string;
  manifest: IntegrationManifestView;
  authStatuses: IntegrationAuthStatus[];
  agentTools: string[] | "*" | undefined;
  agentScopes: string[] | undefined;
  persistence?: ConnectionPickerPersistence;
  /**
   * Version selector for the readiness verdict (#770). A non-`draft` value
   * pins the per-integration resolution + run-blocking flag to that published
   * manifest so the run-options modal matches the run. Omitted → draft.
   */
  version?: string;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: resolution, isPending } = useIntegrationAgentResolution(
    integrationId,
    agentPackageId,
    version,
  );
  // Authoritative run-blocking flag for this integration (run semantics) — same
  // bulk query as the launch badge, selected per-integration.
  const { data: runBlocking } = useIntegrationRunBlocking(integrationId, agentPackageId, version);
  const upsertPin = useUpsertMemberIntegrationPin();
  const deletePin = useDeleteMemberIntegrationPin();
  const { openPopup, isPending: oauthPending } = useHostedConnectPopup();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Uncommitted checkbox state. `null` = untouched since the last write, so
  // the draft reads the bound set; toggling forks it, "Valider" writes it.
  const [draft, setDraft] = useState<string[] | null>(null);

  const overrideMode = persistence.mode === "override";
  const auths = manifest.auths ?? {};
  // Only auths the actor can actually connect: oauth2 needs an admin OAuth
  // client (else the connect 403s); api_key/basic/custom always can. Without
  // this the "add connection" entries offered a flow doomed to 403.
  const connectable = connectableAuthKeys(manifest, authStatuses);
  const authKeys = Object.keys(auths).filter((k) => connectable.has(k));
  const typeLabel = (authKey: string): string | null => {
    const type = auths[authKey]?.type;
    return type ? t(`settings:integration.auth.type.${type}`) : null;
  };
  // The whole verdict (cascade + scope diff) is computed server-side; a pin
  // write or scope upgrade invalidates it so the dropdown re-resolves.
  const refresh = () => invalidateIntegrationQueries(qc);

  if (isPending || !resolution) {
    return (
      <div data-testid={`member-picker-${integrationId}`}>
        <Button variant="outline" size="sm" disabled className="h-7 gap-1.5 text-xs">
          <Loader2 className="size-3 animate-spin" />
        </Button>
      </div>
    );
  }

  const {
    candidates,
    status,
    resolved_connection_ids: resolvedConnectionIds,
    admin_pinned_connection_ids: adminPinnedConnectionIds,
    member_pinned_connection_ids: memberPinnedConnectionIds,
    org_default_connection_ids: orgDefaultConnectionIds,
    org_default_enforced: orgDefaultEnforced,
    can_add_connection: canAddConnection,
  } = resolution;

  const byId = (id: string): IntegrationCandidate | undefined =>
    candidates.find((c) => c.id === id);
  const ownerLabel = (c: IntegrationCandidate): string =>
    c.is_own
      ? t("detail.integrationMemberPicker.byYou")
      : (c.owner_name ?? t("detail.integrationMemberPicker.ownerUnknown"));

  // Locked when an admin force applies and the member can never override:
  // a per-agent admin pin OR an enforced org default. Either way we render
  // the read-only lock instead of the editable dropdown. (A schedule override
  // would lose to either at run time, so locking it here is correct too.)
  const lockedConnectionIds = adminPinnedConnectionIds.length
    ? adminPinnedConnectionIds
    : orgDefaultEnforced
      ? orgDefaultConnectionIds
      : [];
  if (lockedConnectionIds.length > 0) {
    const label = lockedConnectionIds
      .map((id) => {
        const pinned = byId(id);
        return pinned ? pinned.label : id;
      })
      .join(" · ");
    return (
      <div data-testid={`member-picker-${integrationId}`}>
        <Button
          variant="outline"
          size="sm"
          disabled
          className="h-7 justify-start gap-1.5 text-xs"
          data-testid={`member-pick-locked-${integrationId}`}
        >
          <Lock className="size-3" />
          <span className="truncate">{label}</span>
          <Badge variant="secondary" className="ml-1 text-[0.6rem]">
            {t("detail.integrationMemberPicker.adminLocked", {
              count: lockedConnectionIds.length,
            })}
          </Badge>
        </Button>
      </div>
    );
  }

  // Empty means "no member pin" in pin mode and "inherit" in override mode —
  // `displayedConnectionIds` owns that split.
  const explicitIds = overrideMode ? persistence.value : memberPinnedConnectionIds;
  const boundIds = displayedConnectionIds({
    overrideMode,
    explicitIds,
    resolvedIds: resolvedConnectionIds,
  });
  const dirty = draft !== null;
  // Checkboxes only: an inheriting override pre-checks the cascade's answer so
  // the first click refines it, while the trigger still reads "inherit".
  const checkedIds = draft ?? (boundIds.length > 0 ? boundIds : resolvedConnectionIds);
  const checked = new Set(checkedIds);
  const atCap = checked.size >= MAX_CONNECTIONS_PER_INTEGRATION;
  // Nothing to compose — clicking the row binds it outright, as it always did.
  const oneClick = candidates.length === 1;

  // The trigger reflects the bound set, never the uncommitted draft.
  const displayConns = boundIds.map(byId).filter((c): c is IntegrationCandidate => !!c);
  // Warnings answer for the set "Valider" would write, so an override with no
  // pick — a valid inherit state — warns about nothing.
  const verdictConns = (dirty ? checkedIds : boundIds)
    .map(byId)
    .filter((c): c is IntegrationCandidate => !!c);
  const underScopedConns = verdictConns.filter((c) => c.missing_scopes.length > 0);
  const underScoped = underScopedConns.length > 0;
  // Same rule as the resolver's 412 `duplicate_connection_label`, from core.
  const collidingLabels = [...new Set(labelsSharedBy(verdictConns).map((c) => c.label))];
  const hasCandidates = candidates.length > 0;

  // A write REPLACES the set; the refresh re-resolves the candidate list.
  const commit = async (connectionIds: string[]) => {
    if (overrideMode) persistence.onChange(connectionIds);
    else await upsertPin.mutateAsync({ agentPackageId, integrationId, connectionIds });
    setDraft(null);
    await refresh();
  };

  const toggle = (connectionId: string) =>
    setDraft(toggleCapped(checkedIds, connectionId, MAX_CONNECTIONS_PER_INTEGRATION));

  const clearPick = async () => {
    if (overrideMode) persistence.onChange(EMPTY_CONNECTION_SET);
    else await deletePin.mutateAsync({ agentPackageId, integrationId });
    setDraft(null);
    await refresh();
  };

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
    await openPopup({
      packageId: integrationId,
      authKey,
      ...(scopes.length ? { scopes } : {}),
      // Account picker is noise on a renew — the user is re-authorising the
      // existing identity, not picking a new one. Force-pick stays on fresh
      // connects so "Add another" actually offers a different account.
      ...(isRenew ? {} : { forceAccountSelect: true }),
      ...(opts?.connectionId ? { connectionId: opts.connectionId } : {}),
    });
    if (isRenew) {
      await refresh();
      return;
    }
    const { data: fresh } = await client.GET("/api/agents/{scope}/{name}/connection-readiness", {
      params: {
        path: splitPackageRef(agentPackageId),
        ...(isVersioned(version) ? { query: { version } } : {}),
      },
    });
    const freshCandidates = fresh?.integrations.find((i) => i.integration_id === integrationId)
      ?.resolution.candidates;
    const added = freshCandidates?.find((c) => !before.has(c.id));
    // A fresh connection JOINS the bound set — replacing it would silently
    // unbind what the user already chose; identity means the cap blocked it.
    const next = added ? toggleCapped(boundIds, added.id, MAX_CONNECTIONS_PER_INTEGRATION) : null;
    if (next && next !== boundIds) await commit(next);
    else await refresh();
  };

  const triggerLabel =
    displayConns.length === 1
      ? displayConns[0]!.label
      : displayConns.length > 1
        ? t("detail.integrationMemberPicker.selectedCount", { count: displayConns.length })
        : overrideMode
          ? t("detail.integrationMemberPicker.inherit")
          : status === "must_choose"
            ? t("detail.integrationMemberPicker.chooseLabel")
            : status === "stale"
              ? t("detail.integrationMemberPicker.reconfigureLabel")
              : t("detail.integrationMemberPicker.connectLabel");
  // Warning visuals when there's no usable connection OR the displayed set is
  // under-scoped / label-colliding (run would be blocked). In override mode
  // "no pick" is a valid inherit state, so only those two cases warn.
  //
  // The trigger paints amber on exactly the states that gate a run. In pin mode
  // it reads the server's authoritative `run_blocking` flag (the same bulk
  // connection-readiness query the launch badge uses — and the same resolver the
  // run-kickoff 412 runs, including the required-auth carve-out for inert
  // integrations), so the picker can never disagree with the badge.
  //
  // Override mode (schedule editor) keeps its own rule: "no pick" = inherit is
  // valid, so only the SELECTED override set warns.
  const triggerWarn = overrideMode
    ? underScoped || collidingLabels.length > 0
    : (runBlocking ?? false);
  const TriggerIcon = triggerWarn ? AlertTriangle : displayConns.length > 0 ? Users : Plus;

  // Blocked for this member AND nothing to pick → dead end. Show a
  // disabled, explanatory button instead of an empty dropdown.
  if (!canAddConnection && !hasCandidates) {
    return (
      <div data-testid={`member-picker-${integrationId}`}>
        <Button
          variant="outline"
          size="sm"
          disabled
          className="h-7 justify-start gap-1.5 text-xs"
          data-testid={`member-pick-blocked-${integrationId}`}
        >
          <Lock className="size-3" />
          <span className="truncate">{t("detail.integrationMemberPicker.blockedByAdmin")}</span>
        </Button>
      </div>
    );
  }

  // No existing connection AND no auth the actor can connect on (every
  // oauth2 auth lacks an admin-registered OAuth client) → point at the
  // admin setup instead of an empty dropdown that would only 403.
  if (!hasCandidates && authKeys.length === 0) {
    return (
      <div data-testid={`member-picker-${integrationId}`}>
        <span
          className="text-muted-foreground text-xs"
          data-testid={`member-pick-no-client-${integrationId}`}
        >
          {t("settings:integration.auth.noClientHint")}{" "}
          {/* The sentence names a screen; without the link the reader has to go
              find it. Points at the integration's Configuration tab, where the
              OAuth clients table lives. Shown to everyone, admin or not: a
              non-admin lands on a page that tells them so, which beats a dead
              sentence, and the tab itself is admin-gated anyway. */}
          <Link
            to={`${packageDetailPath("integration", integrationId)}#configuration`}
            className="underline underline-offset-2"
          >
            {t("settings:integration.auth.noClientLink")}
          </Link>
        </span>
      </div>
    );
  }

  return (
    <div data-testid={`member-picker-${integrationId}`}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={`h-7 justify-start gap-1.5 text-xs ${triggerWarn ? "text-amber-600 dark:text-amber-400" : ""}`}
            data-testid={`member-pick-${integrationId}`}
          >
            <TriggerIcon className="size-3" />
            <span className="max-w-[14rem] truncate">{triggerLabel}</span>
            {!overrideMode && status === "auto" && (
              <span className="text-muted-foreground/70">
                {t("detail.integrationMemberPicker.defaultBadge")}
              </span>
            )}
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[20rem]">
          <DropdownMenuLabel className="text-[0.7rem]">
            {t("detail.integrationMemberPicker.title")}
          </DropdownMenuLabel>
          {candidates.map((c) => {
            const tl = typeLabel(c.auth_key);
            const isChecked = checked.has(c.id);
            const isDefault = explicitIds.length === 0 && resolvedConnectionIds.includes(c.id);
            // Only the connection owner can renew via OAuth — a foreign
            // shared connection's tokens belong to someone else. We still
            // let the actor pin a foreign needs_reconnection row (their
            // pick survives once the owner renews it).
            const canRenew =
              c.needs_reconnection && c.is_own && auths[c.auth_key]?.type === "oauth2";
            return (
              <DropdownMenuItem
                key={c.id}
                // A row of a composed set IS a checkbox to a screen reader,
                // named by its own text — so the box below is decorative.
                {...(oneClick ? {} : { role: "menuitemcheckbox", "aria-checked": isChecked })}
                // The cap is a refusal, not a silent no-op.
                disabled={!oneClick && atCap && !isChecked}
                // Toggling must not close the menu — "Valider" writes.
                onSelect={(e) => {
                  if (oneClick) {
                    void commit([c.id]);
                    return;
                  }
                  e.preventDefault();
                  toggle(c.id);
                }}
                data-testid={`member-pick-option-${c.id}`}
              >
                {oneClick ? (
                  <Check className={`size-3.5 ${isChecked ? "" : "opacity-0"}`} />
                ) : (
                  <Checkbox
                    checked={isChecked}
                    // The row carries the role, name and event; this is a glyph.
                    aria-hidden
                    tabIndex={-1}
                    className="pointer-events-none"
                  />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{c.label}</span>
                    {tl && (
                      <Badge variant="outline" className="text-[0.6rem]">
                        {tl}
                      </Badge>
                    )}
                    {c.shared_with_org && (
                      <Badge variant="secondary" className="text-[0.6rem]">
                        {t("detail.integrationMemberPicker.sharedBadge")}
                      </Badge>
                    )}
                    {c.missing_scopes.length > 0 && (
                      <Badge variant="destructive" className="text-[0.6rem]">
                        {t("detail.integrationMemberPicker.missingScopesBadge")}
                      </Badge>
                    )}
                    {isDefault && (
                      <span className="text-muted-foreground/70 text-[0.6rem]">
                        {t("detail.integrationMemberPicker.defaultBadge")}
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground truncate text-[0.65rem]">
                    {t("detail.integrationMemberPicker.connectedBy", { owner: ownerLabel(c) })}
                    {c.needs_reconnection &&
                      ` · ${t("detail.integrationMemberPicker.needsReconnection")}`}
                  </span>
                </div>
                {canRenew && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-1 h-6 gap-1 px-2 text-[0.65rem] text-amber-600 hover:text-amber-700 dark:text-amber-400"
                    disabled={oauthPending}
                    onClick={(e) => {
                      // Block the DropdownMenuItem's onSelect so the renew
                      // click doesn't also toggle the dead row.
                      e.preventDefault();
                      e.stopPropagation();
                      void triggerConnect(c.auth_key, { connectionId: c.id });
                    }}
                    data-testid={`member-pick-renew-${c.id}`}
                    aria-label={t("detail.integrationMemberPicker.renew")}
                  >
                    <RefreshCw className="size-3" />
                    {t("detail.integrationMemberPicker.renew")}
                  </Button>
                )}
              </DropdownMenuItem>
            );
          })}
          {!oneClick && hasCandidates && (
            <DropdownMenuItem
              disabled={checked.size === 0 || (!dirty && explicitIds.length > 0)}
              onSelect={() => void commit(checkedIds)}
              data-testid={`member-pick-apply-${integrationId}`}
            >
              <Check className="size-3.5" />
              <span className="font-medium">
                {t("detail.integrationMemberPicker.apply", { count: checked.size })}
              </span>
            </DropdownMenuItem>
          )}
          {atCap && (
            <DropdownMenuLabel className="text-muted-foreground text-[0.65rem] font-normal">
              {t("detail.integrationMemberPicker.maxReached", {
                max: MAX_CONNECTIONS_PER_INTEGRATION,
              })}
            </DropdownMenuLabel>
          )}
          {explicitIds.length > 0 && (
            <DropdownMenuItem
              onSelect={() => void clearPick()}
              data-testid={`member-pick-reset-${integrationId}`}
            >
              <Check className="size-3.5 opacity-0" />
              <span className="text-muted-foreground">
                {overrideMode
                  ? t("detail.integrationMemberPicker.inherit")
                  : t("detail.integrationMemberPicker.resetToAuto")}
              </span>
            </DropdownMenuItem>
          )}
          {canAddConnection && hasCandidates && authKeys.length > 0 && <DropdownMenuSeparator />}
          {canAddConnection &&
            authKeys.map((k) => {
              const tl = typeLabel(k);
              return (
                <DropdownMenuItem
                  key={`add-${k}`}
                  onSelect={() => void triggerConnect(k)}
                  data-testid={`member-pick-add-${integrationId}-${k}`}
                >
                  <Plus className="size-3.5" />
                  <span>
                    {authKeys.length > 1 && tl
                      ? t("detail.integrationMemberPicker.addVia", { label: tl })
                      : t("detail.integrationMemberPicker.addConnection")}
                  </span>
                </DropdownMenuItem>
              );
            })}
          <DropdownMenuSeparator />
          {/* Escape hatch to the integration page for the full connection
              management surface (rename, share-with-org, delete, OAuth client). */}
          <DropdownMenuItem
            onSelect={() => navigate(`/integrations/${integrationId}`)}
            data-testid={`member-pick-manage-${integrationId}`}
          >
            <Settings className="size-3.5" />
            <span>{t("detail.integrationMemberPicker.manageConnections")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Same name twice: the run is refused until one is renamed. */}
      {collidingLabels.length > 0 && (
        <div
          className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[0.7rem] text-amber-700 dark:text-amber-300"
          data-testid={`member-pick-duplicate-label-${integrationId}`}
        >
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="size-3 shrink-0" />
            <span>
              {t("detail.integrationMemberPicker.duplicateLabel", {
                labels: collidingLabels.join(", "),
              })}
            </span>
          </div>
          <Link
            to={`/integrations/${integrationId}`}
            className="underline underline-offset-2"
            data-testid={`member-pick-rename-link-${integrationId}`}
          >
            {t("detail.integrationMemberPicker.duplicateLabelRename")}
          </Link>
        </div>
      )}
      {/* Under-scoped → blocked server-side. The owner can upgrade in place;
          a foreign owner can only be flagged. */}
      {underScopedConns.map((conn) => (
        <div
          key={conn.id}
          className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[0.7rem] text-amber-700 dark:text-amber-300"
          data-testid={`member-pick-scope-warning-${conn.id}`}
        >
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="size-3 shrink-0" />
            <span>
              {conn.is_own
                ? t("detail.integrationMemberPicker.missingScopesOwn")
                : t("detail.integrationMemberPicker.missingScopesForeign", {
                    owner: ownerLabel(conn),
                  })}
            </span>
          </div>
          <span className="text-foreground/80 font-mono text-[0.65rem] break-words">
            {conn.missing_scopes.join(" ")}
          </span>
          {conn.is_own && auths[conn.auth_key]?.type === "oauth2" && (
            <div>
              <Button
                size="sm"
                disabled={oauthPending}
                onClick={async () => {
                  await openPopup({
                    packageId: integrationId,
                    authKey: conn.auth_key,
                    scopes: conn.missing_scopes,
                    connectionId: conn.id,
                  });
                  // The OAuth callback updated the connection's granted
                  // scopes server-side; refetch so the badge clears
                  // instead of waiting for a window-focus refetch.
                  await refresh();
                }}
                data-testid={`member-pick-upgrade-${conn.id}`}
              >
                <RefreshCw className="mr-1 size-3" />
                {t("detail.integrationMemberPicker.upgradeButton")}
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
