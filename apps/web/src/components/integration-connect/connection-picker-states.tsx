// SPDX-License-Identifier: Apache-2.0

/** The connection picker's read-only states: everything but the dropdown. */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, Lock, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { unavailableConnectionIds } from "../../lib/connection-set";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import { ClearChoiceButton } from "./clear-choice-button";
import type { IntegrationCandidate } from "../../hooks/use-integrations";
import type { ConnectionPicker } from "./use-connection-picker";

export const AMBER_TEXT = "text-amber-600 dark:text-amber-400";

export function PickerWarning({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      className="mt-1.5 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[0.7rem] text-amber-700 dark:text-amber-300"
      data-testid={testId}
    >
      <AlertTriangle className="size-3 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function LoadingPicker({ integrationId }: { integrationId: string }) {
  return (
    <div data-testid={`member-picker-${integrationId}`}>
      <Button variant="outline" size="sm" disabled className="h-7 gap-1.5 text-xs">
        <Loader2 className="size-3 animate-spin" />
      </Button>
    </div>
  );
}

/** A disabled button saying the agent's configuration must change. */
export function ReconfigurePicker({ integrationId }: { integrationId: string }) {
  const { t } = useTranslation(["agents", "settings"]);
  return (
    <div data-testid={`member-picker-${integrationId}`}>
      <DisabledReasonTooltip reason={t("error.authKeyServesNoSelectedTool")}>
        <Button
          variant="outline"
          size="sm"
          disabled
          className="h-7 justify-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"
          data-testid={`member-pick-reconfigure-${integrationId}`}
        >
          <AlertTriangle className="size-3" />
          <span className="truncate">{t("detail.integrationMemberPicker.reconfigureLabel")}</span>
        </Button>
      </DisabledReasonTooltip>
    </div>
  );
}

/**
 * The locked set, read-only. A stored override within it narrows it, so that subset is what
 * binds; one reaching outside it is refused (`override_outranked`) and offered its only fix,
 * being cleared.
 */
export function LockedPicker({
  integrationId,
  overrideMode,
  explicitIds,
  onClear,
  lockedConnectionIds,
  lockedBy,
  candidateIds,
  runBlocking,
  setLabel,
}: {
  integrationId: string;
  overrideMode: boolean;
  explicitIds: string[];
  onClear: () => void;
  lockedConnectionIds: string[];
  lockedBy: ConnectionPicker["lockedBy"];
  candidateIds: string[];
  runBlocking: boolean | undefined;
  setLabel: ConnectionPicker["setLabel"];
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const storedOverride = overrideMode ? explicitIds : [];
  const outranked = storedOverride.some((id) => !lockedConnectionIds.includes(id));
  const bindingIds = storedOverride.length > 0 && !outranked ? storedOverride : lockedConnectionIds;
  const lockedUnavailableIds = unavailableConnectionIds(bindingIds, candidateIds);
  return (
    <div data-testid={`member-picker-${integrationId}`}>
      <Button
        variant="outline"
        size="sm"
        disabled
        className={`h-7 justify-start gap-1.5 text-xs ${runBlocking ? AMBER_TEXT : ""}`}
        data-testid={`member-pick-locked-${integrationId}`}
      >
        {runBlocking ? <AlertTriangle className="size-3" /> : <Lock className="size-3" />}
        <span className="truncate">{setLabel(bindingIds, lockedUnavailableIds)}</span>
        <Badge variant="secondary" className="ml-1 text-[0.6rem]">
          {t(
            lockedBy === "org_default"
              ? "detail.integrationMemberPicker.lockedByEnforcedDefault"
              : "detail.integrationMemberPicker.lockedByAdminPin",
            { count: bindingIds.length },
          )}
        </Badge>
      </Button>
      {overrideMode && outranked && (
        <ClearChoiceButton onClick={onClear} testId={`member-pick-clear-${integrationId}`} />
      )}
      {lockedUnavailableIds.length > 0 && (
        <PickerWarning testId={`member-pick-unavailable-warning-${integrationId}`}>
          {t("detail.integrationMemberPicker.lockedUnavailableWarning", {
            count: lockedUnavailableIds.length,
          })}
        </PickerWarning>
      )}
    </div>
  );
}

/** A disabled button naming what blocks adding a connection: the admin's policy or the role. */
export function BlockedPicker({
  integrationId,
  canConnect,
}: {
  integrationId: string;
  canConnect: boolean;
}) {
  const { t } = useTranslation(["agents", "settings"]);
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
        <span className="truncate">
          {t(
            canConnect
              ? "detail.integrationMemberPicker.blockedByAdmin"
              : "detail.integrationMemberPicker.blockedByRole",
          )}
        </span>
      </Button>
    </div>
  );
}

/** A hint pointing at the integration's OAuth client setup, linked when reachable. */
export function NoClientPicker({
  integrationId,
  integrationPath,
  canOpenIntegration,
}: {
  integrationId: string;
  integrationPath: string;
  canOpenIntegration: boolean;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  return (
    <div data-testid={`member-picker-${integrationId}`}>
      <span
        className="text-muted-foreground text-xs"
        data-testid={`member-pick-no-client-${integrationId}`}
      >
        {t("settings:integration.auth.noClientHint")}{" "}
        {/* The sentence names a screen; without the link the reader has to go
            find it. Points at the integration's Configuration tab, where the
            OAuth clients table lives. Shown to whoever may open that page, admin
            or not: a non-admin lands on a page that tells them so, which beats
            a dead sentence, and the tab itself is admin-gated anyway. */}
        {canOpenIntegration && (
          <Link to={`${integrationPath}#configuration`} className="underline underline-offset-2">
            {t("settings:integration.auth.noClientLink")}
          </Link>
        )}
      </span>
    </div>
  );
}

/**
 * Under-scoped → blocked server-side. The owner can upgrade in place;
 * a foreign owner can only be flagged.
 */
export function UnderScopedWarning({
  conn,
  picker,
}: {
  conn: IntegrationCandidate;
  picker: ConnectionPicker;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const { canConnect, auths, ownerLabel, oauthPending, upgradeScopes } = picker;
  return (
    <div
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
      {canConnect && conn.is_own && auths[conn.auth_key]?.type === "oauth2" && (
        <div>
          <Button
            size="sm"
            disabled={oauthPending}
            onClick={() => void upgradeScopes(conn)}
            data-testid={`member-pick-upgrade-${conn.id}`}
          >
            <RefreshCw className="mr-1 size-3" />
            {t("detail.integrationMemberPicker.upgradeButton")}
          </Button>
        </div>
      )}
    </div>
  );
}
