// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Ban,
  Users,
  Check,
  Plus,
  ChevronDown,
  RefreshCw,
  Settings,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
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
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { AMBER_TEXT } from "./connection-picker-states";
import type { ConnectionPicker } from "./use-connection-picker";

/** The picker's dropdown: its trigger, one row per candidate, and the write/connect entries. */
export function PickerMenu({
  integrationId,
  picker,
}: {
  integrationId: string;
  picker: ConnectionPicker;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const navigate = useNavigate();
  const {
    runBlocking,
    candidates,
    resolvedConnectionIds,
    canAddConnection,
    byDefault,
    softDefaultIds,
    emptyPickerPrompt,
    canConnect,
    integrationPath,
    canOpenIntegration,
    overrideMode,
    auths,
    authKeys,
    hasCandidates,
    explicitIds,
    pickedNone,
    canPickNone,
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
    ownerLabel,
    setLabel,
    open,
    setOpen,
    onOpenChange,
    oauthPending,
    persist,
    toggle,
    triggerConnect,
  } = picker;
  const typeLabel = (authKey: string): string | null => {
    const type = auths[authKey]?.type;
    return type ? t(`settings:integration.auth.type.${type}`) : null;
  };
  const triggerLabel =
    unavailableIds.length > 0
      ? setLabel(storedIds, unavailableIds)
      : pickedNone
        ? t("detail.integrationMemberPicker.none")
        : displayConns.length === 1
          ? displayConns[0]!.label
          : displayConns.length > 1
            ? t("detail.integrationMemberPicker.selectedCount", { count: displayConns.length })
            : overrideMode
              ? t("detail.integrationMemberPicker.inherit")
              : emptyPickerPrompt === "choose"
                ? t("detail.integrationMemberPicker.chooseLabel")
                : t("detail.integrationMemberPicker.connectLabel");
  // Amber on exactly the states that gate a run: pin mode reads the server's
  // `run_blocking` (same verdict as the launch badge and the kickoff 409); in
  // override mode an unset pick inherits, so only an under-scoped, unavailable or dead set warns.
  const triggerWarn = overrideMode
    ? underScopedConns.length > 0 || unavailableIds.length > 0 || deadConns.length > 0
    : runBlocking;
  const TriggerIcon = triggerWarn
    ? AlertTriangle
    : pickedNone
      ? Ban
      : displayConns.length > 0
        ? Users
        : Plus;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`h-7 justify-start gap-1.5 text-xs ${triggerWarn ? AMBER_TEXT : ""}`}
          data-testid={`member-pick-${integrationId}`}
        >
          <TriggerIcon className="size-3" />
          <span className="max-w-[14rem] truncate">{triggerLabel}</span>
          {!overrideMode && byDefault && (
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
          const isChecked = checkedIds.includes(c.id);
          const isDefault =
            explicitIds === null &&
            (resolvedConnectionIds.includes(c.id) || softDefaultIds.includes(c.id));
          // Only the connection owner can renew via OAuth — a foreign
          // shared connection's tokens belong to someone else. We still
          // let the actor pin a foreign needs_reconnection row (their
          // pick survives once the owner renews it).
          const canRenew =
            canConnect && c.needs_reconnection && c.is_own && auths[c.auth_key]?.type === "oauth2";
          return (
            <DropdownMenuItem
              key={c.id}
              // The row is the checkbox a screen reader sees; the box is a glyph.
              {...(oneClick ? {} : { role: "menuitemcheckbox", "aria-checked": isChecked })}
              disabled={oneClick ? busy : atCap && !isChecked}
              // Toggling must not close the menu — "Valider" writes.
              onSelect={(e) => {
                if (oneClick) {
                  void persist([c.id]);
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
        {unavailableIds.map((id) => (
          <DropdownMenuItem
            key={id}
            disabled
            {...(oneClick ? {} : { role: "menuitemcheckbox", "aria-checked": false })}
            data-testid={`member-pick-unavailable-${id}`}
          >
            {oneClick ? (
              <Check className="size-3.5 opacity-0" />
            ) : (
              <Checkbox checked={false} aria-hidden tabIndex={-1} className="pointer-events-none" />
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium line-through">
                {t("detail.integrationMemberPicker.unavailableRow")}
              </span>
              <span className="text-muted-foreground truncate text-[0.65rem]">
                {t("detail.integrationMemberPicker.unavailableRowHint")}
              </span>
            </div>
          </DropdownMenuItem>
        ))}
        {!oneClick && hasCandidates && (
          <DropdownMenuItem
            disabled={!canApply}
            onSelect={(e) => {
              // Stays open on a refused write, so the ticks stay editable.
              e.preventDefault();
              void persist(checkedIds).then((ok) => {
                if (ok) setOpen(false);
              });
            }}
            data-testid={`member-pick-apply-${integrationId}`}
          >
            <Check className="size-3.5" />
            <span className="font-medium">
              {t("detail.integrationMemberPicker.apply", { count: checkedIds.length })}
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
        {canPickNone && (
          <DropdownMenuItem
            disabled={busy || pickedNone}
            onSelect={() => void persist([])}
            data-testid={`member-pick-none-${integrationId}`}
          >
            <Check className={`size-3.5 ${pickedNone ? "" : "opacity-0"}`} />
            <div className="flex min-w-0 flex-col">
              <span>{t("detail.integrationMemberPicker.none")}</span>
              <span className="text-muted-foreground text-[0.65rem]">
                {t("detail.integrationMemberPicker.noneHint")}
              </span>
            </div>
          </DropdownMenuItem>
        )}
        {explicitIds !== null && (
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => void persist(null)}
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
        {/* Escape hatch to the integration page for the full connection
            management surface (rename, share-with-org, delete, OAuth client). */}
        {canOpenIntegration && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => navigate(integrationPath)}
              data-testid={`member-pick-manage-${integrationId}`}
            >
              <Settings className="size-3.5" />
              <span>{t("detail.integrationMemberPicker.manageConnections")}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
