// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Lock } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import {
  useConnectionPicker,
  type ConnectionPicker,
  type ConnectionPickerOptions,
  type ConnectionPickerPersistence,
} from "./use-connection-picker";
import { useIntegrationDetail, useIntegrationReadinessEntry } from "../../hooks/use-integrations";
import { unavailableConnectionIds } from "../../lib/connection-set";
import { ClearChoiceButton } from "./clear-choice-button";
import { ConnectionPickerModal } from "./connection-picker-modal";
import {
  AMBER_TEXT,
  BlockedPicker,
  FailedPicker,
  LoadingPicker,
  NoClientPicker,
  PickerLine,
  ReconfigurePicker,
  SetNames,
} from "./connection-picker-states";
import { problemTestId, problemText } from "./picker-problems";

const DEFAULT_PERSISTENCE: ConnectionPickerPersistence = { mode: "pin" };

/**
 * Per-integration connections cell: what binds, as text, and « Modifier », which opens the
 * modal that edits it. Only `persistence` differs between surfaces: where the pick lands (member
 * pin vs. an override held in a form). Under a lock closed to additions it is read-only; open to
 * them, the modal edits the additions.
 */
export function IntegrationConnectionPicker({
  integration,
  ...rest
}: Omit<
  LoadedPickerProps,
  "integrationId" | "manifest" | "authStatuses" | "agentTools" | "agentScopes"
> & {
  integration: { id: string; tools?: string[] | "*"; scopes?: string[] };
}) {
  const { data: detail, isError } = useIntegrationDetail(integration.id);
  if (!detail)
    return isError ? (
      <FailedPicker integrationId={integration.id} />
    ) : (
      <LoadingPicker integrationId={integration.id} />
    );
  return (
    <LoadedPicker
      {...rest}
      integrationId={integration.id}
      manifest={detail.manifest}
      authStatuses={detail.auths}
      agentTools={integration.tools}
      agentScopes={integration.scopes}
    />
  );
}

type LoadedPickerProps = Omit<ConnectionPickerOptions, "persistence"> & {
  persistence?: ConnectionPickerPersistence;
};

function LoadedPicker({ persistence = DEFAULT_PERSISTENCE, ...options }: LoadedPickerProps) {
  const { integrationId, agentPackageId, version } = options;
  const picker = useConnectionPicker({ ...options, persistence });
  const { isError } = useIntegrationReadinessEntry(integrationId, agentPackageId, version);

  // Failure first: `isPending` is false once a query failed, so a missing verdict alone would spin forever.
  if (isError) return <FailedPicker integrationId={integrationId} />;
  if (!picker) return <LoadingPicker integrationId={integrationId} />;

  const { canAddConnection, closedLock, additionsAllowed, candidates, authKeys, explicitIds } =
    picker;

  // Nothing to pick or connect: the agent's configuration must change, whatever the lock.
  if (picker.emptyPickerPrompt === "reconfigure") {
    return <ReconfigurePicker integrationId={integrationId} />;
  }

  // An admin force (pin or enforced org default) closed to additions renders read-only: nothing
  // chosen adds to it, or removes from it.
  if (closedLock) return <LockedPicker integrationId={integrationId} picker={picker} />;

  // Dead end (blocked, nothing to pick): explanatory button, unless a stored set is left to clear.
  // An open lock is never one: its set binds, and the cell says so.
  const nothingToPick = !additionsAllowed && candidates.length === 0 && explicitIds === null;
  if (nothingToPick && !canAddConnection) {
    return <BlockedPicker integrationId={integrationId} canConnect={picker.canConnect} />;
  }

  // No connection and no connectable auth (no OAuth client): point at admin setup, not a 403 dropdown.
  if (nothingToPick && authKeys.length === 0) {
    return (
      <NoClientPicker
        integrationId={integrationId}
        integrationPath={picker.integrationPath}
        canOpenIntegration={picker.canOpenIntegration}
      />
    );
  }

  return <EditableCell integrationId={integrationId} picker={picker} />;
}

/** What binds, its problems one line each, and « Modifier ». */
function EditableCell({
  integrationId,
  picker,
}: {
  integrationId: string;
  picker: ConnectionPicker;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const [editing, setEditing] = useState(false);
  const { summary, gatesRun } = picker;
  const text = (() => {
    switch (summary.kind) {
      case "set":
        return (
          <SetNames
            imposed={summary.imposed}
            chosen={summary.chosen}
            unavailable={summary.unavailable}
          />
        );
      case "none":
        return t("detail.integrationMemberPicker.none");
      case "inherit":
        return summary.conns.length > 0
          ? t("detail.integrationMemberPicker.inheritTrigger", {
              name: summary.conns.map((c) => c.label).join(" · "),
            })
          : t("detail.integrationMemberPicker.inherit");
      case "choose":
        return t("detail.integrationMemberPicker.chooseLabel");
      case "connect":
        return null;
    }
  })();
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={`member-picker-${integrationId}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {text !== null && (
          <span
            className={cn("flex min-w-0 items-center gap-1.5 text-sm", gatesRun && AMBER_TEXT)}
            data-testid={`member-pick-${integrationId}`}
          >
            {gatesRun && <AlertTriangle className="size-4 shrink-0" />}
            {text}
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setEditing(true)}
          data-testid={`member-pick-edit-${integrationId}`}
        >
          {summary.kind === "connect"
            ? t("detail.integrationMemberPicker.connectLabel")
            : t("common:btn.edit")}
        </Button>
      </div>
      {picker.problems.map((problem) => (
        <PickerLine
          key={problemTestId("member-pick", integrationId, problem)}
          testId={problemTestId("member-pick", integrationId, problem)}
        >
          {problemText(t, problem, picker)}
        </PickerLine>
      ))}
      {editing && (
        <ConnectionPickerModal
          integrationId={integrationId}
          picker={picker}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/**
 * A lock closed to additions, read-only: the locked set is what binds, whatever is chosen. A
 * stored override within it is a no-op; one reaching outside it is refused (`override_outranked`),
 * which is said. Either can be cleared, back to the cascade the lock governs anyway.
 */
function LockedPicker({
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
    candidates,
    gatesRun,
  } = picker;
  const storedOverride = overrideMode ? explicitIds : null;
  const outranked = storedOverride?.some((id) => !lockedConnectionIds.includes(id)) ?? false;
  const unavailable = unavailableConnectionIds(
    lockedConnectionIds,
    candidates.map((c) => c.id),
  );
  const locked = lockedConnectionIds.flatMap((id) => candidates.find((c) => c.id === id) ?? []);
  const warn = outranked || gatesRun;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={`member-picker-${integrationId}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          className={cn("flex min-w-0 items-center gap-1.5 text-sm", warn && AMBER_TEXT)}
          data-testid={`member-pick-locked-${integrationId}`}
        >
          {warn ? (
            <AlertTriangle className="size-4 shrink-0" />
          ) : (
            <Lock className="size-4 shrink-0" />
          )}
          {lockedConnectionIds.length === 0 ? (
            t("detail.integrationMemberPicker.none")
          ) : (
            <SetNames imposed={[]} chosen={locked} unavailable={unavailable.length} />
          )}
          <Badge variant="secondary" className="text-[0.6rem]">
            {t(
              lockedBy === "org_default"
                ? "detail.integrationMemberPicker.lockedByEnforcedDefault"
                : "detail.integrationMemberPicker.lockedByAdminPin",
              { count: lockedConnectionIds.length },
            )}
          </Badge>
        </span>
        {storedOverride !== null && (
          <ClearChoiceButton
            onClick={() => void persist(null)}
            testId={`member-pick-clear-${integrationId}`}
          />
        )}
      </div>
      {outranked && (
        <PickerLine testId={`member-pick-outranked-warning-${integrationId}`}>
          {t("error.overrideOutranked")}
        </PickerLine>
      )}
      {unavailable.length > 0 && (
        <PickerLine testId={`member-pick-locked-unavailable-warning-${integrationId}`}>
          {t("detail.integrationMemberPicker.lockedUnavailableWarning", {
            count: unavailable.length,
          })}
        </PickerLine>
      )}
    </div>
  );
}
