// SPDX-License-Identifier: Apache-2.0

/** The connection picker's states besides the editable cell, and the lines that say what is wrong. */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Lock } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";

/** The warning tone of a picker line (the constant keeps the name its callers import). */
export const AMBER_TEXT = "text-warning";

/** One line saying what is wrong, with the way out beside it when there is one. */
export function PickerLine({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div className="text-warning flex items-start gap-1.5 text-xs" data-testid={testId}>
      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 break-words">{children}</div>
    </div>
  );
}

/** The connections a set binds, as text: the imposed ones behind a padlock, then the others. */
export function SetNames({
  imposed,
  chosen,
  unavailable,
}: {
  imposed: readonly { label: string }[];
  chosen: readonly { label: string }[];
  unavailable: number;
}) {
  const { t } = useTranslation(["agents"]);
  const rest = [
    ...chosen.map((c) => c.label),
    ...(unavailable > 0
      ? [t("detail.integrationMemberPicker.unavailableCount", { count: unavailable })]
      : []),
  ];
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1">
      {imposed.length > 0 && (
        <span className="inline-flex items-center gap-1">
          <Lock className="size-3 shrink-0" />
          <span>{imposed.map((c) => c.label).join(" · ")}</span>
        </span>
      )}
      {rest.length > 0 && (
        <span>
          {imposed.length > 0 ? "· " : ""}
          {rest.join(" · ")}
        </span>
      )}
    </span>
  );
}

export function LoadingPicker({ integrationId }: { integrationId: string }) {
  return (
    <div data-testid={`member-picker-${integrationId}`}>
      <Skeleton className="h-7 w-32 rounded-md" />
    </div>
  );
}

/** A picker that edits nothing: a disabled button saying why. */
function StatusPicker({
  integrationId,
  testId,
  icon,
  label,
  tone,
  reason,
}: {
  integrationId: string;
  testId: string;
  icon: ReactNode;
  label: ReactNode;
  tone?: string;
  /** Said in a tooltip on the dead button. */
  reason?: string;
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
        </Button>
      </DisabledReasonTooltip>
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
