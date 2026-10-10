// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, XCircle, Puzzle, Check, Loader2 } from "lucide-react";
import type { AgentIntegrationEntry } from "@appstrate/shared-types";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import { IntegrationConnectionPicker } from "./integration-connect/integration-connection-picker";
import { unboundLabel } from "./integration-connect/integration-run-readiness";
import { useIntegrationDetail, useIntegrationReadinessEntry } from "../hooks/use-integrations";
import { usePermissions } from "../hooks/use-permissions";
import {
  integrationIdOfField,
  isStructuralCode,
  retryDecision,
  type ConnectionOverridesMap,
  type MissingIntegrationFieldError,
} from "../lib/connection-choice";
import { withConnectionPick, type ConnectionSet } from "../lib/connection-set";
import { refusalMessage } from "../lib/mutation-error";

interface MissingConnectionsModalProps {
  open: boolean;
  onClose: () => void;
  errors: MissingIntegrationFieldError[];
  /** The agent whose run 409'd; keys the server resolution each picker consumes. */
  agentPackageId?: string;
  /** The version the refused launch ran: `required` (and so "no connection") is that version's. */
  version?: string;
  /** The agent's tools/scopes per integration, so a (re)connect requests exactly those. */
  integrationEntries?: AgentIntegrationEntry[];
  /** Re-run with the picked overrides. */
  onRetryWithOverrides: (overrides: ConnectionOverridesMap) => void;
  /** Disables the retry button while the new run is in flight. */
  retrying?: boolean;
}

/**
 * Recovery surface for the run-kickoff `409 missing_integration_connection`: one row per
 * `errors[]` entry. Actionable rows embed `IntegrationConnectionPicker` in `override` mode;
 * validated sets accumulate into the `connection_overrides` "Re-run" hands to
 * `onRetryWithOverrides`. Structural failures keep a plain message: no pick fixes them.
 */
export function MissingConnectionsModal({
  open,
  onClose,
  errors,
  agentPackageId,
  version,
  integrationEntries,
  onRetryWithOverrides,
  retrying,
}: MissingConnectionsModalProps) {
  const { t } = useTranslation(["agents"]);
  const [picks, setPicks] = useState<ConnectionOverridesMap>({});

  const integrationErrors = errors.filter((e) => e.field.startsWith("integrations."));
  const { mustChoose, showRetry, canRetry } = retryDecision(integrationErrors, picks, retrying);

  // A `null` pick drops the key: the re-run falls back to the cascade.
  const setPick = (integrationId: string, connectionIds: ConnectionSet) =>
    setPicks((prev) => withConnectionPick(prev, integrationId, connectionIds));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("missingConnections.title")}
      actions={
        <div className="flex items-center gap-2">
          {showRetry && (
            <Button
              onClick={() => onRetryWithOverrides(picks)}
              disabled={!canRetry}
              data-testid="must-choose-retry"
            >
              {retrying && <Spinner />}
              {mustChoose
                ? t("missingConnections.mustChoose.retry")
                : t("missingConnections.retry")}
            </Button>
          )}
        </div>
      }
    >
      <p className="text-muted-foreground mb-3 text-sm">{t("missingConnections.intro")}</p>
      {/* Cap the list height so a long set of integrations scrolls inside the
          modal instead of overflowing past it (and pushing the footer out of
          view). `-mr-2 pr-2` insets the scrollbar without clipping row borders. */}
      <div className="-mr-2 max-h-[55vh] space-y-2 overflow-y-auto pr-2">
        {integrationErrors.map((err, i) => (
          <MissingRow
            key={`${err.field}-${i}`}
            err={err}
            agentPackageId={agentPackageId}
            version={version}
            integrationEntries={integrationEntries}
            pick={picks[integrationIdOfField(err.field)] ?? null}
            onPick={setPick}
          />
        ))}
      </div>
    </Modal>
  );
}

/** One refused integration: its live verdict for the launched version, and a picker when a pick can fix it. */
export function MissingRow({
  err,
  agentPackageId,
  version,
  integrationEntries,
  pick,
  onPick,
}: {
  err: MissingIntegrationFieldError;
  agentPackageId?: string;
  version?: string;
  integrationEntries?: AgentIntegrationEntry[];
  /** Current per-run pick set for this integration; `null` = no override. */
  pick: ConnectionSet;
  onPick: (integrationId: string, connectionIds: ConnectionSet) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const packageId = integrationIdOfField(err.field);
  const { data: detail } = useIntegrationDetail(packageId);
  const readsIntegrations = usePermissions().can("integrations:read");
  // Structural failures can't be fixed by connecting — an admin must activate
  // the integration, or the agent's dependency or configuration must change. No picker.
  const isStructural = isStructuralCode(err.code);

  // Server-authoritative verdict — the SAME `IntegrationAgentResolution` the
  // Connexions tab and the launch-readiness badge consume (the picker below
  // fetches it too; React Query dedupes the shared key). The header reflects it
  // live: the connect/renew flow invalidates the `["integrations", …]` prefix
  // (hosted connect portal popup close, `connection_update` SSE), this query
  // refetches, and the header flips to resolved without a manual Re-run.
  const { data: verdict } = useIntegrationReadinessEntry(
    isStructural ? undefined : packageId,
    isStructural ? undefined : agentPackageId,
    version,
  );
  const resolution = verdict?.resolution;
  const entry = integrationEntries?.find((e) => e.id === packageId);

  // Resolved = the run-kickoff gate would no longer reject it; no verdict is not "ready".
  const resolved = !!verdict && !verdict.run_blocking;
  const unbound = unboundLabel(verdict?.resolution.warning ?? null);
  // The picker needs the manifest + first verdict to render fully wired; hold
  // a spinner until both land (non-structural rows with the agent in context).
  // Both reads gate on `integrations:read`: without it neither lands, so the
  // row names the integration and waits for nothing.
  const pickable = !isStructural && !!agentPackageId && readsIntegrations;
  const canRenderPicker = pickable && !!detail && !!resolution;
  const loadingVerdict = pickable && (!detail || !resolution);

  const displayName = detail?.manifest.display_name ?? packageId;
  // An item code this build has no sentence for keeps the resolver's own message.
  const message = refusalMessage(err) ?? err.message;
  const Icon = resolved ? Check : isStructural ? XCircle : AlertTriangle;
  const colorClass = resolved
    ? "text-emerald-600"
    : isStructural
      ? "text-destructive"
      : "text-amber-500";

  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-md border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Puzzle className="text-muted-foreground size-4 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{displayName}</div>
            <div className={`flex items-center gap-1.5 truncate text-xs ${colorClass}`}>
              <Icon className="size-3" />
              {/* `title` because the row TRUNCATES: a structural message can
                  carry the server's diagnosis (e.g. the manifest schema issues
                  behind `integration_invalid_manifest`), and a cause clipped at
                  the row width is a cause the user never reads. */}
              <span className="truncate" title={resolved ? undefined : message}>
                {unbound ?? (resolved ? t("missingConnections.resolved") : message)}
              </span>
            </div>
          </div>
        </div>
        {loadingVerdict && (
          <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
        )}
      </div>
      {canRenderPicker && (
        <div className="border-border/60 mt-1 border-t pt-2">
          <IntegrationConnectionPicker
            integrationId={packageId}
            agentPackageId={agentPackageId}
            manifest={detail.manifest}
            authStatuses={detail.auths}
            agentTools={entry?.tools}
            agentScopes={entry?.scopes}
            version={version}
            persistence={{
              mode: "override",
              value: pick,
              onChange: (connectionIds) => onPick(packageId, connectionIds),
            }}
          />
        </div>
      )}
    </div>
  );
}
