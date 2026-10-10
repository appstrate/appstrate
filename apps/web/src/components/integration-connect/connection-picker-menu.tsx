// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
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
  type LucideIcon,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
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
import { useSpaces } from "../../hooks/use-spaces";
import type { IntegrationCandidate } from "../../hooks/use-integrations";
import { AMBER_TEXT } from "./connection-picker-states";
import { ScopeSummaryText } from "./scope-summary-text";
import type { ConnectionPicker } from "./use-connection-picker";

/** What the closed trigger shows, first match wins. */
type TriggerKind = "unavailable" | "none" | "one" | "many" | "inherit" | "choose" | "connect";

function triggerKind(p: ConnectionPicker): TriggerKind {
  if (p.unavailableIds.length > 0) return "unavailable";
  if (p.pickedNone) return "none";
  if (p.displayConns.length === 1 && p.explicitIds !== null) return "one";
  if (p.displayConns.length > 1 && p.explicitIds !== null) return "many";
  // Nothing chosen: the trigger reads "Hériter", unless the picker is what asks for an act.
  if (p.overrideMode || p.inheritedConns.length > 0) return "inherit";
  return p.emptyPickerPrompt === "choose" ? "choose" : "connect";
}

// A "+" says "add": only the entry that connects carries it.
const TRIGGER_ICONS: Record<TriggerKind, LucideIcon> = {
  unavailable: Users,
  none: Ban,
  one: Users,
  many: Users,
  inherit: Users,
  choose: Users,
  connect: Plus,
};

/** One choice of the menu: its label, and one line saying what it means. */
function ChoiceLabel({ label, description }: { label: string; description: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-medium">{label}</span>
      <span className="text-muted-foreground text-[0.65rem] break-words">{description}</span>
    </div>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The picker's dropdown: its trigger, the choices in cascade order, and the write/connect entries. */
export function PickerMenu({
  integrationId,
  picker,
}: {
  integrationId: string;
  picker: ConnectionPicker;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const navigate = useNavigate();
  const { data: spaces } = useSpaces();
  const {
    runBlocking,
    candidates,
    canAddConnection,
    canConnect,
    integrationPath,
    canOpenIntegration,
    overrideMode,
    auths,
    authKeys,
    hasCandidates,
    explicitIds,
    pickedNone,
    required,
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
    scopeFitOf,
    manifest,
    missingScopeLabels,
    connectsWithAgentScopes,
    inheritedConns,
    inheritedSource,
    inheritedUnbound,
    open,
    setOpen,
    onOpenChange,
    oauthPending,
    persist,
    toggle,
    triggerConnect,
    renewConnection,
  } = picker;
  const typeLabel = (authKey: string): string | null => {
    const type = auths[authKey]?.type;
    return type ? t(`settings:integration.auth.type.${type}`) : null;
  };
  // The owner of an org-scoped row reads where it was connected from; anyone else, who owns it.
  const provenance = (c: IntegrationCandidate): string => {
    const origin =
      c.is_own && c.scope === "org"
        ? spaces?.find((s) => s.id === c.origin_space_id)?.name
        : undefined;
    return origin
      ? t("detail.integrationMemberPicker.connectedFrom", { space: origin })
      : t("detail.integrationMemberPicker.connectedBy", { owner: ownerLabel(c) });
  };
  // « Clé API · connectée depuis Default »: what the connection is, then where it comes from.
  const candidateDescription = (c: IntegrationCandidate): string =>
    [
      typeLabel(c.auth_key),
      c.shared_here ? lowerFirst(t("detail.integrationMemberPicker.sharedBadge")) : null,
      lowerFirst(provenance(c)),
      c.needs_reconnection
        ? lowerFirst(t("detail.integrationMemberPicker.needsReconnection"))
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ")
      .replace(/^./, (first) => first.toUpperCase());
  // A fresh connect requests the agent's scopes: saying so is what makes it the safe choice
  // over upgrading a shared connection.
  const addLabel = (authKey: string): string => {
    const tl = authKeys.length > 1 ? typeLabel(authKey) : null;
    if (connectsWithAgentScopes(authKey)) {
      return tl
        ? t("detail.integrationMemberPicker.newWithAgentScopesVia", { label: tl })
        : t("detail.integrationMemberPicker.newWithAgentScopes");
    }
    return tl
      ? t("detail.integrationMemberPicker.addVia", { label: tl })
      : t("detail.integrationMemberPicker.addConnection");
  };
  // "Hériter" says which connection the cascade gives and which layer gives it, in the server's
  // words (`run.connSource.*`).
  const inheritedNames = inheritedConns.map((c) => c.label).join(" · ");
  const inheritDescription = (() => {
    if (inheritedConns.length > 0) {
      const name = inheritedNames;
      switch (inheritedSource) {
        case "org_default":
        case "org_default_enforced":
          return t("detail.integrationMemberPicker.inheritFromSpaceDefault", {
            name,
            count: inheritedConns.length,
          });
        case "fallback_auto":
          return t("detail.integrationMemberPicker.inheritFromOwn", { name });
        case "member_pin":
          return t("detail.integrationMemberPicker.inheritFromPin", { name });
        default:
          return t("detail.integrationMemberPicker.inheritUses", { name });
      }
    }
    // Under a member pin the verdict is the pin's: it says nothing of what inheriting would give.
    return overrideMode || explicitIds === null
      ? (inheritedUnbound ?? t("detail.integrationMemberPicker.inheritNone"))
      : t("detail.integrationMemberPicker.inheritGeneric");
  })();
  const trigger = triggerKind(picker);
  const triggerLabel = {
    unavailable: () => setLabel(storedIds, unavailableIds),
    none: () => t("detail.integrationMemberPicker.none"),
    one: () => displayConns[0]!.label,
    many: () => t("detail.integrationMemberPicker.selectedCount", { count: displayConns.length }),
    inherit: () =>
      inheritedNames
        ? t("detail.integrationMemberPicker.inheritTrigger", { name: inheritedNames })
        : t("detail.integrationMemberPicker.inherit"),
    choose: () => t("detail.integrationMemberPicker.chooseLabel"),
    connect: () => t("detail.integrationMemberPicker.connectLabel"),
  }[trigger]();
  // Amber on exactly the states that gate a run: pin mode reads the server's
  // `run_blocking` (same verdict as the launch badge and the kickoff 409); in
  // override mode an unset pick inherits, so only an under-scoped, unavailable or dead set
  // warns — or a stored "no connection" for an integration the agent now requires.
  const triggerWarn = overrideMode
    ? underScopedConns.length > 0 ||
      unavailableIds.length > 0 ||
      deadConns.length > 0 ||
      (pickedNone && required)
    : runBlocking;
  const TriggerIcon = triggerWarn ? AlertTriangle : TRIGGER_ICONS[trigger];
  // What the menu ticks is what is CHOSEN. "Hériter" and "Aucune connexion" exclude the explicit
  // connections: ticking one of these while the other is on stands for the whole change.
  const ticking = checkedIds.length > 0;
  const inheritChecked = explicitIds === null && !ticking;
  const noneChecked = pickedNone && !ticking;
  // One connection to pick from: radios. Several: boxes, written by "Valider".
  const choiceRole = oneClick ? "menuitemradio" : "menuitemcheckbox";
  const indicator = (checked: boolean) =>
    oneClick ? (
      <Check className={`size-3.5 ${checked ? "" : "opacity-0"}`} />
    ) : (
      <Checkbox checked={checked} aria-hidden tabIndex={-1} className="pointer-events-none" />
    );

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
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[20rem]">
        <DropdownMenuLabel className="text-[0.7rem]">
          {t("detail.integrationMemberPicker.title")}
        </DropdownMenuLabel>
        {/* The cascade's turn comes first: the default, then what is chosen over it, then none.
            Ticking it again does nothing; going back is picking it. */}
        <DropdownMenuItem
          role={choiceRole}
          aria-checked={inheritChecked}
          disabled={busy}
          onSelect={() => {
            if (explicitIds !== null) void persist(null);
          }}
          data-testid={`member-pick-reset-${integrationId}`}
        >
          {indicator(inheritChecked)}
          <ChoiceLabel
            label={t("detail.integrationMemberPicker.inherit")}
            description={inheritDescription}
          />
        </DropdownMenuItem>
        {candidates.map((c) => {
          const fit = scopeFitOf(c);
          const missing = missingScopeLabels(c).join(", ");
          const isChecked = checkedIds.includes(c.id);
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
              role={choiceRole}
              aria-checked={isChecked}
              disabled={oneClick ? busy : atCap && !isChecked}
              // Toggling must not close the menu — "Valider" writes.
              onSelect={(e) => {
                if (oneClick) {
                  // Ticked already: nothing to do (back to the cascade is "Hériter").
                  if (explicitIds?.length === 1 && explicitIds[0] === c.id) return;
                  void persist([c.id]);
                  return;
                }
                e.preventDefault();
                toggle(c.id);
              }}
              data-testid={`member-pick-option-${c.id}`}
            >
              {indicator(isChecked)}
              <div className="flex min-w-0 flex-1 flex-col">
                {/* An incompatible row is muted on its name; its reason stays legible. */}
                <span className={`truncate font-medium ${fit === "missing" ? "opacity-60" : ""}`}>
                  {c.label}
                </span>
                <span className="text-muted-foreground text-[0.65rem] break-words">
                  {candidateDescription(c)}
                </span>
                {fit === "missing" ? (
                  <span
                    className={`truncate text-[0.65rem] ${AMBER_TEXT}`}
                    title={c.missing_scopes.join(" ")}
                  >
                    {t("detail.integrationMemberPicker.missingScopes", { scopes: missing })}
                  </span>
                ) : (
                  <ScopeSummaryText
                    manifest={manifest}
                    authKey={c.auth_key}
                    scopes={c.scopes_granted}
                    className="text-muted-foreground truncate text-[0.65rem]"
                  />
                )}
                {fit === "broader" && (
                  <span className="text-muted-foreground truncate text-[0.65rem] italic">
                    {t("detail.integrationMemberPicker.broaderThanAgent")}
                  </span>
                )}
              </div>
              {canRenew && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-warning hover:text-warning ml-1 h-6 gap-1 px-2 text-[0.65rem]"
                  disabled={oauthPending}
                  onClick={(e) => {
                    // Block the DropdownMenuItem's onSelect so the renew
                    // click doesn't also toggle the dead row.
                    e.preventDefault();
                    e.stopPropagation();
                    void renewConnection(c);
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
            role={choiceRole}
            aria-checked={false}
            data-testid={`member-pick-unavailable-${id}`}
          >
            {indicator(false)}
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
        {atCap && (
          <DropdownMenuLabel className="text-muted-foreground text-[0.65rem] font-normal">
            {t("detail.integrationMemberPicker.maxReached", {
              max: MAX_CONNECTIONS_PER_INTEGRATION,
            })}
          </DropdownMenuLabel>
        )}
        {!required && (
          <DropdownMenuItem
            role={choiceRole}
            aria-checked={noneChecked}
            disabled={busy}
            onSelect={() => {
              if (!pickedNone) void persist([]);
            }}
            data-testid={`member-pick-none-${integrationId}`}
          >
            {indicator(noneChecked)}
            <ChoiceLabel
              label={t("detail.integrationMemberPicker.none")}
              description={t("detail.integrationMemberPicker.noneHint")}
            />
          </DropdownMenuItem>
        )}
        {/* Nothing ticked, nothing to write: "Hériter" and "Aucune connexion" write on their own. */}
        {!oneClick && hasCandidates && ticking && (
          <>
            <DropdownMenuSeparator />
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
          </>
        )}
        {canAddConnection && hasCandidates && authKeys.length > 0 && <DropdownMenuSeparator />}
        {canAddConnection &&
          authKeys.map((k) => (
            <DropdownMenuItem
              key={`add-${k}`}
              onSelect={() => void triggerConnect(k)}
              data-testid={`member-pick-add-${integrationId}-${k}`}
            >
              <Plus className="size-3.5" />
              <span>{addLabel(k)}</span>
            </DropdownMenuItem>
          ))}
        {/* Escape hatch to the integration page for the full connection
            management surface (rename, sharing, delete, OAuth client). */}
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
