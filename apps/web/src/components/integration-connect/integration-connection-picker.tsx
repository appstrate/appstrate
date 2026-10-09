// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  useConnectionPicker,
  type ConnectionPickerOptions,
  type ConnectionPickerPersistence,
} from "./use-connection-picker";
import { PickerMenu } from "./connection-picker-menu";
import {
  BlockedPicker,
  LoadingPicker,
  LockedPicker,
  NoClientPicker,
  PickerWarning,
  ReconfigurePicker,
  UnderScopedWarning,
} from "./connection-picker-states";

// Module-level constant so the default prop is a stable reference across
// renders (a `{ mode: "pin" }` literal default would be a new object each
// render — react/no-object-type-as-default-prop).
const DEFAULT_PERSISTENCE: ConnectionPickerPersistence = { mode: "pin" };

/**
 * Per-integration connection picker, rendered as a rich dropdown. Lists every
 * accessible connection (own + shared-with-org) with its name, auth type
 * (OAuth / API key …), and who created it, plus a "no connection" entry, a reset entry and "add a
 * connection" entries (one per declared auth) that launch the connect flow
 * inline.
 *
 * Rows are checkboxes composing a draft set (up to
 * `MAX_CONNECTIONS_PER_INTEGRATION`) that "Valider" writes in one go;
 * with a single candidate, clicking its row binds it directly.
 *
 * Single source of truth for "which connections?" UX — shared by the agent
 * page (member pins) and the schedule editor (per-schedule overrides) via the
 * `persistence` prop. The candidate list, scope/lock verdicts and the connect
 * orchestration (hosted connect portal popup) are identical across both; only
 * where the pick lands differs.
 */
export function IntegrationConnectionPicker({
  persistence = DEFAULT_PERSISTENCE,
  ...options
}: Omit<ConnectionPickerOptions, "persistence"> & { persistence?: ConnectionPickerPersistence }) {
  const { t } = useTranslation(["agents", "settings"]);
  const { integrationId } = options;
  const picker = useConnectionPicker({ ...options, persistence });

  if (!picker) return <LoadingPicker integrationId={integrationId} />;

  const {
    canAddConnection,
    lockedBy,
    emptyPickerPrompt,
    canConnect,
    integrationPath,
    canOpenIntegration,
    hasCandidates,
    authKeys,
    explicitIds,
    fromDefault,
    unavailableIds,
    deadConns,
    underScopedConns,
  } = picker;

  // Nothing to pick or connect: the agent's configuration must change, whatever the lock.
  if (emptyPickerPrompt === "reconfigure") {
    return <ReconfigurePicker integrationId={integrationId} />;
  }

  // An admin force (pin or enforced org default) renders read-only: a member pin loses to it.
  if (lockedBy !== null) {
    return <LockedPicker integrationId={integrationId} picker={picker} />;
  }

  // Blocked for this member AND nothing to pick → dead end. Show a
  // disabled, explanatory button instead of an empty dropdown.
  // Unless a stored set is left to clear: the menu's reset item is the way out.
  if (!canAddConnection && !hasCandidates && explicitIds === null) {
    return <BlockedPicker integrationId={integrationId} canConnect={canConnect} />;
  }

  // No existing connection AND no auth the actor can connect on (every
  // oauth2 auth lacks an admin-registered OAuth client) → point at the
  // admin setup instead of an empty dropdown that would only 403 — unless a
  // stored set is left to clear, as above.
  if (!hasCandidates && authKeys.length === 0 && explicitIds === null) {
    return (
      <NoClientPicker
        integrationId={integrationId}
        integrationPath={integrationPath}
        canOpenIntegration={canOpenIntegration}
      />
    );
  }

  return (
    <div data-testid={`member-picker-${integrationId}`}>
      <PickerMenu integrationId={integrationId} picker={picker} />
      {/* A stored member is unusable: the run is refused until the set is re-picked
          — or, for the space default, until the member picks their own or an
          admin fixes the default. */}
      {unavailableIds.length > 0 && (
        <PickerWarning testId={`member-pick-unavailable-warning-${integrationId}`}>
          {t(
            fromDefault
              ? "detail.integrationMemberPicker.defaultUnavailableWarning"
              : "detail.integrationMemberPicker.unavailableWarning",
            { count: unavailableIds.length },
          )}
        </PickerWarning>
      )}
      {/* A dead member fails every run that binds it until its owner reconnects it. */}
      {deadConns.length > 0 && (
        <PickerWarning testId={`member-pick-dead-warning-${integrationId}`}>
          {t("detail.integrationMemberPicker.needsReconnectionWarning", {
            count: deadConns.length,
          })}
        </PickerWarning>
      )}
      {/* Under-scoped → blocked server-side: a new connection with the agent's
          scopes first, an in-place upgrade (owner only) second. */}
      {underScopedConns.map((conn) => (
        <UnderScopedWarning key={conn.id} conn={conn} picker={picker} />
      ))}
    </div>
  );
}
