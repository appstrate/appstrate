// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { AlertTriangle, Ban, Lock, Users, Plus, RefreshCw, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import { useSpaceLabelOf } from "../../hooks/use-spaces";
import type { IntegrationCandidate } from "../../hooks/use-integrations";
import { AMBER_TEXT } from "./connection-picker-states";
import { ConnectionChoiceMenu, type ChoiceRow } from "./connection-choice-menu";
import { ScopeSummaryText } from "./scope-summary-text";
import type { ConnectionPicker } from "./use-connection-picker";

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The agent's connection picker: the one choice menu, fed by the readiness verdict. Under an
 * admin pin open to additions its connections are listed first, ticked and padlocked, and the
 * choice is the additions alone.
 */
export function PickerMenu({
  integrationId,
  picker,
}: {
  integrationId: string;
  picker: ConnectionPicker;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const navigate = useNavigate();
  const spaceLabelOf = useSpaceLabelOf();
  const {
    gatesRun,
    canAddConnection,
    additionsAllowed,
    imposedIds,
    imposedUnavailableIds,
    menuCandidates,
    storedMode,
    offersInherit,
    noneValue,
    canConnect,
    integrationPath,
    canOpenIntegration,
    auths,
    authKeys,
    hasCandidates,
    emptyPickerPrompt,
    overrideMode,
    explicitIds,
    pickedNone,
    shownIds,
    required,
    unavailableIds,
    checkedIds,
    oneClick,
    displayConns,
    busy,
    canApply,
    ownerLabel,
    setLabel,
    manifest,
    missingScopeLabels,
    connectsWithAgentScopes,
    inheritedConns,
    inheritedSource,
    inheritedUnbound,
    open,
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
    const origin = c.is_own && c.scope === "org" ? spaceLabelOf(c.origin_space_id) : undefined;
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
  // The first match wins. A "+" says "add": only the entry that connects carries it.
  const trigger = (() => {
    // Open to additions: the whole set that binds, the imposed connections first.
    if (additionsAllowed) {
      return {
        icon: Lock,
        label: setLabel(shownIds, [...imposedUnavailableIds, ...unavailableIds]),
      };
    }
    if (unavailableIds.length > 0) {
      return { icon: Users, label: setLabel(shownIds, unavailableIds) };
    }
    if (pickedNone) return { icon: Ban, label: t("detail.integrationMemberPicker.none") };
    if (displayConns.length > 0 && explicitIds !== null) {
      return {
        icon: Users,
        label:
          displayConns.length === 1
            ? displayConns[0]!.label
            : t("detail.integrationMemberPicker.selectedCount", { count: displayConns.length }),
      };
    }
    // Nothing chosen: the trigger reads "Hériter", unless the picker is what asks for an act.
    if (overrideMode || inheritedConns.length > 0) {
      return {
        icon: Users,
        label: inheritedNames
          ? t("detail.integrationMemberPicker.inheritTrigger", { name: inheritedNames })
          : t("detail.integrationMemberPicker.inherit"),
      };
    }
    return emptyPickerPrompt === "choose"
      ? { icon: Users, label: t("detail.integrationMemberPicker.chooseLabel") }
      : { icon: Plus, label: t("detail.integrationMemberPicker.connectLabel") };
  })();
  const rows: ChoiceRow[] = menuCandidates.map((c) => {
    const fit = c.scope_fit;
    const missing = missingScopeLabels(c).join(", ");
    // Only the connection owner can renew via OAuth — a foreign
    // shared connection's tokens belong to someone else. We still
    // let the actor pin a foreign needs_reconnection row (their
    // pick survives once the owner renews it).
    const canRenew =
      canConnect && c.needs_reconnection && c.is_own && auths[c.auth_key]?.type === "oauth2";
    return {
      id: c.id,
      name: c.label,
      muted: fit === "missing",
      description: candidateDescription(c),
      extra: (
        <>
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
        </>
      ),
      trailing: canRenew ? (
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
          <RefreshCw />
          {t("detail.integrationMemberPicker.renew")}
        </Button>
      ) : undefined,
    };
  });

  return (
    <ConnectionChoiceMenu
      testPrefix="member-pick"
      testKey={integrationId}
      title={t("detail.integrationMemberPicker.title")}
      compact
      trigger={{
        label: trigger.label,
        icon: gatesRun ? AlertTriangle : trigger.icon,
        warn: gatesRun,
      }}
      storedMode={storedMode}
      {...(offersInherit ? { inherit: { description: inheritDescription } } : {})}
      {...(additionsAllowed
        ? {
            // The imposed set is never empty, so « no addition » is open to a required one too.
            none: {
              label: t("detail.integrationMemberPicker.noAddition"),
              description: t("detail.integrationMemberPicker.noAdditionHint"),
            },
          }
        : required
          ? {}
          : { none: { description: t("detail.integrationMemberPicker.noneHint") } })}
      rows={rows}
      checkedIds={checkedIds}
      {...(additionsAllowed
        ? {
            imposed: {
              ids: imposedIds,
              hint: t("detail.integrationMemberPicker.imposedHint"),
            },
          }
        : {})}
      unavailableIds={unavailableIds}
      unavailableRow={{
        label: t("detail.integrationMemberPicker.unavailableRow"),
        hint: t("detail.integrationMemberPicker.unavailableRowHint"),
      }}
      busy={busy}
      onToggle={(id) => {
        if (!oneClick) {
          toggle(id);
          return;
        }
        // One connection to pick from: ticking it writes at once, unticking it goes back to the
        // cascade, the only other answer that is not « none » (open to additions, to no addition).
        const unticked = additionsAllowed ? noneValue : null;
        void persist(checkedIds.includes(id) ? unticked : [id]).then((ok) => {
          if (ok) onOpenChange(false);
        });
      }}
      onInherit={() => void persist(null)}
      onNone={() => void persist(noneValue)}
      {...(!oneClick && hasCandidates
        ? {
            apply: {
              enabled: canApply,
              onApply: () =>
                void persist(checkedIds).then((ok) => {
                  if (ok) onOpenChange(false);
                }),
            },
          }
        : {})}
      open={open}
      onOpenChange={onOpenChange}
      footer={
        <>
          {canAddConnection && hasCandidates && authKeys.length > 0 && <DropdownMenuSeparator />}
          {canAddConnection &&
            authKeys.map((k) => (
              <DropdownMenuItem
                key={`add-${k}`}
                onSelect={() => void triggerConnect(k)}
                data-testid={`member-pick-add-${integrationId}-${k}`}
              >
                <Plus />
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
                <Settings />
                <span>{t("detail.integrationMemberPicker.manageConnections")}</span>
              </DropdownMenuItem>
            </>
          )}
        </>
      }
    />
  );
}
