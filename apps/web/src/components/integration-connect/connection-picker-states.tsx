// SPDX-License-Identifier: Apache-2.0

/** The connection picker's states besides the dropdown, and the warnings shown under it. */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Lock, Plus, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { unavailableConnectionIds } from "../../lib/connection-set";
import { ConfirmModal } from "../confirm-modal";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import { ClearChoiceButton } from "./clear-choice-button";
import type { IntegrationCandidate } from "../../hooks/use-integrations";
import type { ConnectionPicker } from "./use-connection-picker";

/** The warning tone of a picker line (the constant keeps the name its callers import). */
export const AMBER_TEXT = "text-warning";

export function PickerWarning({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <Alert
      variant="warning"
      className="bg-warning/10 mt-1.5 rounded-md p-2 text-[0.7rem] [&>svg]:top-[0.65rem] [&>svg]:left-2 [&>svg+div]:translate-y-0 [&>svg~*]:pl-5"
      data-testid={testId}
    >
      <AlertTriangle className="size-3" />
      <AlertDescription className="text-[0.7rem]">{children}</AlertDescription>
    </Alert>
  );
}

export function LoadingPicker({ integrationId }: { integrationId: string }) {
  return (
    <div data-testid={`member-picker-${integrationId}`}>
      <Skeleton className="h-7 w-32 rounded-md" />
    </div>
  );
}

/** A picker that offers no menu: a disabled button saying why, with what sits beside it. */
function StatusPicker({
  integrationId,
  testId,
  icon,
  label,
  tone,
  reason,
  badge,
  children,
}: {
  integrationId: string;
  testId: string;
  icon: ReactNode;
  label: ReactNode;
  tone?: string;
  /** Said in a tooltip on the dead button. */
  reason?: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div data-testid={`member-picker-${integrationId}`}>
      <DisabledReasonTooltip reason={reason}>
        <Button
          variant="outline"
          size="sm"
          disabled
          className={cn("h-7 justify-start gap-1.5 text-xs", tone)}
          data-testid={testId}
        >
          {icon}
          <span className="truncate">{label}</span>
          {badge}
        </Button>
      </DisabledReasonTooltip>
      {children}
    </div>
  );
}

/** The verdict could not be read: a disabled button that says so, never a spinner. */
export function FailedPicker({ integrationId }: { integrationId: string }) {
  const { t } = useTranslation(["agents", "settings"]);
  return (
    <StatusPicker
      integrationId={integrationId}
      testId={`member-pick-failed-${integrationId}`}
      icon={<AlertTriangle className="text-destructive" />}
      label={t("detail.integrationMemberPicker.resolutionFailed")}
      reason={t("detail.integrationMemberPicker.resolutionFailedHint")}
    />
  );
}

/** A disabled button saying the agent's configuration must change. */
export function ReconfigurePicker({ integrationId }: { integrationId: string }) {
  const { t } = useTranslation(["agents", "settings"]);
  return (
    <StatusPicker
      integrationId={integrationId}
      testId={`member-pick-reconfigure-${integrationId}`}
      icon={<AlertTriangle />}
      tone={AMBER_TEXT}
      label={t("detail.integrationMemberPicker.reconfigureLabel")}
      reason={t("error.authKeyServesNoSelectedTool")}
    />
  );
}

/**
 * The locked set, read-only. A stored override within it narrows it, so that subset is what
 * binds (`[]`: none) and what the picker is judged on; one reaching outside it is refused
 * (`override_outranked`), which is said. Either can be cleared back to the locked set; in
 * override mode, `[]` (if not required) narrows any lock.
 */
export function LockedPicker({
  integrationId,
  picker,
}: {
  integrationId: string;
  picker: ConnectionPicker;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const {
    overrideMode,
    explicitIds,
    persist,
    lockedConnectionIds,
    lockedBy,
    candidateIds,
    gatesRun,
    required,
    setLabel,
  } = picker;
  const storedOverride = overrideMode ? explicitIds : null;
  const outranked = storedOverride?.some((id) => !lockedConnectionIds.includes(id)) ?? false;
  const bindingIds = storedOverride !== null && !outranked ? storedOverride : lockedConnectionIds;
  const lockedUnavailableIds = unavailableConnectionIds(bindingIds, candidateIds);
  const clearable = outranked || storedOverride?.length === 0;
  const warn = outranked || gatesRun;
  const offersNone =
    overrideMode && !required && lockedConnectionIds.length > 0 && storedOverride?.length !== 0;
  return (
    <StatusPicker
      integrationId={integrationId}
      testId={`member-pick-locked-${integrationId}`}
      icon={warn ? <AlertTriangle /> : <Lock />}
      tone={warn ? AMBER_TEXT : undefined}
      label={
        bindingIds.length === 0
          ? t("detail.integrationMemberPicker.none")
          : setLabel(bindingIds, lockedUnavailableIds)
      }
      badge={
        <Badge variant="secondary" className="ml-1 text-[0.6rem]">
          {t(
            lockedBy === "org_default"
              ? "detail.integrationMemberPicker.lockedByEnforcedDefault"
              : "detail.integrationMemberPicker.lockedByAdminPin",
            { count: bindingIds.length },
          )}
        </Badge>
      }
    >
      {offersNone && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto py-1 text-left text-xs"
          onClick={() => void persist([])}
          data-testid={`member-pick-none-${integrationId}`}
        >
          <span className="flex min-w-0 flex-col">
            <span>{t("detail.integrationMemberPicker.none")}</span>
            <span className="text-muted-foreground text-[0.65rem]">
              {t("detail.integrationMemberPicker.noneHint")}
            </span>
          </span>
        </Button>
      )}
      {clearable && (
        <ClearChoiceButton
          onClick={() => void persist(null)}
          testId={`member-pick-clear-${integrationId}`}
        />
      )}
      {outranked && (
        <PickerWarning testId={`member-pick-outranked-warning-${integrationId}`}>
          {t("error.overrideOutranked")}
        </PickerWarning>
      )}
      {lockedUnavailableIds.length > 0 && (
        <PickerWarning testId={`member-pick-unavailable-warning-${integrationId}`}>
          {t("detail.integrationMemberPicker.lockedUnavailableWarning", {
            count: lockedUnavailableIds.length,
          })}
        </PickerWarning>
      )}
    </StatusPicker>
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
    <StatusPicker
      integrationId={integrationId}
      testId={`member-pick-blocked-${integrationId}`}
      icon={<Lock />}
      label={t(
        canConnect
          ? "detail.integrationMemberPicker.blockedByAdmin"
          : "detail.integrationMemberPicker.blockedByRole",
      )}
    />
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
 * Under-scoped → blocked server-side. The way out offered first is a new connection with the
 * agent's scopes. Upgrading in place widens the grant of every agent bound to the connection,
 * so the owner gets it second, behind a confirmation; a foreign owner's can only be flagged.
 */
export function UnderScopedWarning({
  conn,
  picker,
}: {
  conn: IntegrationCandidate;
  picker: ConnectionPicker;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const {
    canConnect,
    canAddConnection,
    authKeys,
    auths,
    ownerLabel,
    oauthPending,
    triggerConnect,
    upgradeScopes,
    upgradeTargetId,
    setUpgradeTargetId,
    missingScopeLabels,
  } = picker;
  const missing = missingScopeLabels(conn).join(", ");
  const canCreate = canAddConnection && authKeys.includes(conn.auth_key);
  const canUpgrade = canConnect && conn.is_own && auths[conn.auth_key]?.type === "oauth2";
  return (
    <div
      className="border-warning/40 bg-warning/10 text-warning mt-1.5 flex flex-col gap-1.5 rounded-md border p-2 text-[0.7rem]"
      data-testid={`member-pick-scope-warning-${conn.id}`}
    >
      <div className="flex items-center gap-1.5">
        <AlertTriangle className="size-3 shrink-0" />
        <span>
          {conn.is_own
            ? t("detail.integrationMemberPicker.missingScopesOwn")
            : t(
                canCreate
                  ? "detail.integrationMemberPicker.missingScopesForeignCanCreate"
                  : "detail.integrationMemberPicker.missingScopesForeign",
                { owner: ownerLabel(conn) },
              )}
        </span>
      </div>
      <span className="text-foreground/80 break-words" title={conn.missing_scopes.join(" ")}>
        {t("detail.integrationMemberPicker.missingScopes", { scopes: missing })}
      </span>
      {(canCreate || canUpgrade) && (
        <div className="flex flex-wrap gap-1.5">
          {canCreate && (
            <Button
              size="sm"
              disabled={oauthPending}
              onClick={() => void triggerConnect(conn.auth_key, { replacing: conn.id })}
              data-testid={`member-pick-new-for-agent-${conn.id}`}
            >
              <Plus className="mr-1" />
              {t("detail.integrationMemberPicker.newWithAgentScopes")}
            </Button>
          )}
          {canUpgrade && (
            <Button
              size="sm"
              variant="outline"
              disabled={oauthPending}
              onClick={() => setUpgradeTargetId(conn.id)}
              data-testid={`member-pick-upgrade-${conn.id}`}
            >
              <RefreshCw className="mr-1" />
              {t("detail.integrationMemberPicker.upgradeButton")}
            </Button>
          )}
        </div>
      )}
      <ConfirmModal
        open={upgradeTargetId === conn.id}
        onClose={() => setUpgradeTargetId(null)}
        onConfirm={() => {
          setUpgradeTargetId(null);
          void upgradeScopes(conn);
        }}
        title={t("detail.integrationMemberPicker.upgradeConfirmTitle")}
        description={t("detail.integrationMemberPicker.upgradeConfirmDescription", {
          scopes: missing,
        })}
        confirmLabel={t("detail.integrationMemberPicker.upgradeConfirmButton")}
        variant="default"
      />
    </div>
  );
}
