// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Plus, RefreshCw } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { CheckboxField } from "@/components/app-ui/checkbox-field";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { useSpaceLabelOf } from "../../hooks/use-spaces";
import { useIntegrationName } from "../../hooks/use-integration-name";
import type { IntegrationCandidate } from "../../hooks/use-integrations";
import { toggleCapped, type ConnectionSet } from "../../lib/connection-set";
import { ConfirmModal } from "../confirm-modal";
import { FormModal } from "../form-modal";
import { AMBER_TEXT, PickerLine } from "./connection-picker-states";
import { problemTestId, problemText } from "./picker-problems";
import { ScopeSummaryText } from "./scope-summary-text";
import type { ConnectionPicker, PickerProblem } from "./use-connection-picker";

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * « Modifier » of a connections cell: the candidates as boxes (the imposed ones ticked and
 * locked), the problems of what is ticked with their way out, and one write on « Enregistrer »,
 * « Revenir au choix par défaut » (`null`) or « Aucune connexion » (`[]`). Mounted while open:
 * closing drops the ticks.
 */
export function ConnectionPickerModal({
  integrationId,
  picker,
  onClose,
}: {
  integrationId: string;
  picker: ConnectionPicker;
  onClose: () => void;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const name = useIntegrationName(integrationId);
  const [ticked, setTicked] = useState<string[]>(picker.initialTicks);
  const [upgradeTargetId, setUpgradeTargetId] = useState<string | null>(null);
  const { busy, offersDefault, offersNone } = picker;
  const value = picker.saveValue(ticked);
  // Stays open on a refused write: the mutation toasted why, the ticks are still there.
  const write = (next: ConnectionSet) =>
    void picker.persist(next).then((ok) => {
      if (ok) onClose();
    });
  return (
    <FormModal
      title={t("detail.integrationMemberPicker.modalTitle", { name })}
      description={t(
        picker.imposedIds.length > 0
          ? "detail.integrationMemberPicker.modalHintImposed"
          : "detail.integrationMemberPicker.modalHint",
      )}
      onClose={onClose}
      isPending={busy}
      submitDisabled={value === undefined}
      submitTestId={`member-pick-save-${integrationId}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (value !== undefined) write(value);
      }}
      secondaryActions={
        <>
          {offersDefault && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => write(null)}
              data-testid={`member-pick-default-${integrationId}`}
            >
              {t("detail.integrationMemberPicker.useDefault")}
            </Button>
          )}
          {offersNone && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => write([])}
              data-testid={`member-pick-none-${integrationId}`}
            >
              {t("detail.integrationMemberPicker.none")}
            </Button>
          )}
        </>
      }
    >
      <ConnectionPickerFields
        integrationId={integrationId}
        picker={picker}
        ticked={ticked}
        onToggle={(id) => setTicked(toggleCapped(ticked, id, picker.additionCap))}
        onConnect={(authKey, replacing) =>
          void picker
            .triggerConnect(authKey, { ticked, ...(replacing ? { replacing } : {}) })
            .then((ok) => {
              if (ok) onClose();
            })
        }
        upgradeTargetId={upgradeTargetId}
        onUpgradeTarget={setUpgradeTargetId}
      />
    </FormModal>
  );
}

/** The modal's body, apart from its chrome (a portal a static render drops). */
export function ConnectionPickerFields({
  integrationId,
  picker,
  ticked,
  onToggle,
  onConnect,
  upgradeTargetId,
  onUpgradeTarget,
}: {
  integrationId: string;
  picker: ConnectionPicker;
  /** What is ticked, the imposed connections aside. */
  ticked: readonly string[];
  onToggle: (id: string) => void;
  /** Connects a new connection, in place of `replacing` when given. */
  onConnect: (authKey: string, replacing?: string) => void;
  /** The connection whose upgrade awaits a confirmation. */
  upgradeTargetId: string | null;
  onUpgradeTarget: (id: string | null) => void;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const {
    listedCandidates,
    imposedIds,
    busy,
    oauthPending,
    canAddConnection,
    authKeys,
    auths,
    connectsWithAgentScopes,
  } = picker;
  const atCap = imposedIds.length + ticked.length >= MAX_CONNECTIONS_PER_INTEGRATION;
  // What « Enregistrer » would bind, and the stored members it drops (said until it does).
  const problems = picker.problemsOf([...ticked, ...picker.unavailableIds]);
  const typeLabel = (authKey: string): string | null => {
    const type = auths[authKey]?.type;
    return type ? t(`settings:integration.auth.type.${type}`) : null;
  };
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

  return (
    <>
      {listedCandidates.length > 0 && (
        <div role="group" className="flex flex-col gap-3">
          {listedCandidates.map((c) => {
            const imposed = imposedIds.includes(c.id);
            const checked = imposed || ticked.includes(c.id);
            return (
              <CheckboxField
                key={c.id}
                id={`member-pick-option-${c.id}`}
                data-testid={`member-pick-option-${c.id}`}
                label={c.label}
                description={
                  <CandidateLines
                    conn={c}
                    picker={picker}
                    typeLabel={typeLabel}
                    imposed={imposed}
                  />
                }
                checked={checked}
                disabled={busy || imposed || (!checked && atCap)}
                onCheckedChange={() => onToggle(c.id)}
              />
            );
          })}
          {atCap && (
            <p className="text-muted-foreground text-xs">
              {t("detail.integrationMemberPicker.maxReached", {
                max: MAX_CONNECTIONS_PER_INTEGRATION,
              })}
            </p>
          )}
        </div>
      )}
      {problems.length > 0 && (
        <div className="flex flex-col gap-2">
          {problems.map((problem) => (
            <PickerLine
              key={problemTestId("member-pick-modal", integrationId, problem)}
              testId={problemTestId("member-pick-modal", integrationId, problem)}
            >
              <span>{problemText(t, problem, picker)}</span>
              <ProblemActions
                problem={problem}
                picker={picker}
                onConnect={onConnect}
                upgradeTargetId={upgradeTargetId}
                onUpgradeTarget={onUpgradeTarget}
              />
            </PickerLine>
          ))}
        </div>
      )}
      {canAddConnection && authKeys.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {authKeys.map((k) => (
            <Button
              key={k}
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || oauthPending}
              onClick={() => onConnect(k)}
              data-testid={`member-pick-add-${integrationId}-${k}`}
            >
              <Plus />
              {addLabel(k)}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

/** A row's lines: what it is and where it comes from, then its grant against the agent. */
function CandidateLines({
  conn: c,
  picker,
  typeLabel,
  imposed,
}: {
  conn: IntegrationCandidate;
  picker: ConnectionPicker;
  typeLabel: (authKey: string) => string | null;
  imposed: boolean;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const spaceLabelOf = useSpaceLabelOf();
  // The owner of an org-scoped row reads where it was connected from; anyone else, who owns it.
  const origin = c.is_own && c.scope === "org" ? spaceLabelOf(c.origin_space_id) : undefined;
  const provenance = origin
    ? t("detail.integrationMemberPicker.connectedFrom", { space: origin })
    : t("detail.integrationMemberPicker.connectedBy", { owner: picker.ownerLabel(c) });
  // « Clé API · connectée depuis Default »: what the connection is, then where it comes from.
  const description = [
    typeLabel(c.auth_key),
    c.shared_here ? lowerFirst(t("detail.integrationMemberPicker.sharedBadge")) : null,
    lowerFirst(provenance),
    c.needs_reconnection ? lowerFirst(t("detail.integrationMemberPicker.needsReconnection")) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ")
    .replace(/^./, (first) => first.toUpperCase());
  return (
    <span className="flex flex-col gap-0.5">
      <span>{description}</span>
      {imposed && (
        <span className="flex items-center gap-1" data-testid={`member-pick-imposed-${c.id}`}>
          <Lock className="size-3 shrink-0" />
          {t("detail.integrationMemberPicker.imposedHint")}
        </span>
      )}
      {c.scope_fit === "missing" ? (
        <span className={AMBER_TEXT} title={c.missing_scopes.join(" ")}>
          {t("detail.integrationMemberPicker.missingScopes", {
            scopes: picker.missingScopeLabels(c).join(", "),
          })}
        </span>
      ) : (
        <ScopeSummaryText
          manifest={picker.manifest}
          authKey={c.auth_key}
          scopes={c.scopes_granted}
          className=""
        />
      )}
      {c.scope_fit === "broader" && (
        <span className="italic">{t("detail.integrationMemberPicker.broaderThanAgent")}</span>
      )}
    </span>
  );
}

/**
 * The way out of a problem. A dead connection: its owner renews it. An under-scoped one: a new
 * connection with the agent's scopes first; upgrading in place widens the grant of every agent
 * bound to it, so the owner gets it second, behind a confirmation.
 */
export function ProblemActions({
  problem,
  picker,
  onConnect,
  upgradeTargetId,
  onUpgradeTarget,
}: {
  problem: PickerProblem;
  picker: ConnectionPicker;
  onConnect: (authKey: string, replacing?: string) => void;
  upgradeTargetId: string | null;
  onUpgradeTarget: (id: string | null) => void;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  if (problem.kind !== "dead" && problem.kind !== "underScoped") return null;
  const { conn } = problem;
  const { oauthPending, busy } = picker;
  const canFix = picker.canFixInPlace(conn);
  if (problem.kind === "dead") {
    if (!canFix) return null;
    return (
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={oauthPending}
          onClick={() => void picker.renewConnection(conn)}
          data-testid={`member-pick-renew-${conn.id}`}
        >
          <RefreshCw />
          {t("detail.integrationMemberPicker.renew")}
        </Button>
      </div>
    );
  }
  const canCreate = picker.canAddConnection && picker.authKeys.includes(conn.auth_key);
  if (!canCreate && !canFix) return null;
  const missing = picker.missingScopeLabels(conn).join(", ");
  return (
    <div className="flex flex-wrap gap-1.5">
      {canCreate && (
        <Button
          type="button"
          size="sm"
          disabled={busy || oauthPending}
          onClick={() => onConnect(conn.auth_key, conn.id)}
          data-testid={`member-pick-new-for-agent-${conn.id}`}
        >
          <Plus />
          {t("detail.integrationMemberPicker.newWithAgentScopes")}
        </Button>
      )}
      {canFix && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={oauthPending}
          onClick={() => onUpgradeTarget(conn.id)}
          data-testid={`member-pick-upgrade-${conn.id}`}
        >
          <RefreshCw />
          {t("detail.integrationMemberPicker.upgradeButton")}
        </Button>
      )}
      <ConfirmModal
        open={upgradeTargetId === conn.id}
        onClose={() => onUpgradeTarget(null)}
        onConfirm={() => {
          onUpgradeTarget(null);
          void picker.upgradeScopes(conn);
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
