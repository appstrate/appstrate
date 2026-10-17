// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  useConnectionPicker,
  type ConnectionPickerOptions,
  type ConnectionPickerPersistence,
} from "./use-connection-picker";
import { useIntegrationDetail, useIntegrationReadinessEntry } from "../../hooks/use-integrations";
import { PickerMenu } from "./connection-picker-menu";
import {
  BlockedPicker,
  FailedPicker,
  LoadingPicker,
  LockedPicker,
  LockedUnavailableWarning,
  NoClientPicker,
  PickerWarning,
  ReconfigurePicker,
  UnderScopedWarning,
} from "./connection-picker-states";

const DEFAULT_PERSISTENCE: ConnectionPickerPersistence = { mode: "pin" };

/**
 * Per-integration connection picker (dropdown). Rows are checkboxes composing a draft set
 * (up to `MAX_CONNECTIONS_PER_INTEGRATION`) that "Valider" writes in one go; a single
 * candidate binds directly. Only `persistence` differs between surfaces: where the pick lands
 * (member pin vs. an override held in a form). Under a lock closed to additions it is read-only;
 * open to them, the menu stays and the pick is the additions.
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
  const { t } = useTranslation(["agents", "settings"]);
  const { integrationId, agentPackageId, version } = options;
  const picker = useConnectionPicker({ ...options, persistence });
  const { isError } = useIntegrationReadinessEntry(integrationId, agentPackageId, version);

  // Failure first: `isPending` is false once a query failed, so a missing verdict alone would spin forever.
  if (isError) return <FailedPicker integrationId={integrationId} />;
  if (!picker) return <LoadingPicker integrationId={integrationId} />;

  const {
    canAddConnection,
    lockedBy,
    additionsAllowed,
    imposedUnavailableIds,
    tooLarge,
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

  // An admin force (pin or enforced org default) closed to additions renders read-only: nothing
  // chosen adds to it, or removes from it.
  if (lockedBy !== null && !additionsAllowed) {
    return <LockedPicker integrationId={integrationId} picker={picker} />;
  }

  // Dead end (blocked, nothing to pick): explanatory button, unless a stored set is left to clear.
  // An open lock is never one: its set binds, and the menu says so.
  if (!additionsAllowed && !canAddConnection && !hasCandidates && explicitIds === null) {
    return <BlockedPicker integrationId={integrationId} canConnect={canConnect} />;
  }

  // No connection and no connectable auth (no OAuth client): point at admin setup, not a 403 dropdown.
  if (!additionsAllowed && !hasCandidates && authKeys.length === 0 && explicitIds === null) {
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
      <LockedUnavailableWarning integrationId={integrationId} ids={imposedUnavailableIds} />
      {tooLarge && (
        <PickerWarning testId={`member-pick-too-large-warning-${integrationId}`}>
          {t("error.connectionSetTooLarge")}
        </PickerWarning>
      )}
      {deadConns.length > 0 && (
        <PickerWarning testId={`member-pick-dead-warning-${integrationId}`}>
          {t("detail.integrationMemberPicker.needsReconnectionWarning", {
            count: deadConns.length,
          })}
        </PickerWarning>
      )}
      {underScopedConns.map((conn) => (
        <UnderScopedWarning key={conn.id} conn={conn} picker={picker} />
      ))}
    </div>
  );
}
