// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { AlertTriangle, XCircle, Puzzle, Check } from "lucide-react";
import type { AgentIntegrationEntry } from "@appstrate/shared-types";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { IntegrationConnectionPicker } from "./integration-connect/integration-connection-picker";
import { unboundLabel } from "./integration-connect/integration-run-readiness";
import {
  blockingIntegrationIds,
  useAgentConnectionReadiness,
  useIntegrationReadinessEntry,
} from "../hooks/use-integrations";
import { useIntegrationName } from "../hooks/use-integration-name";
import { usePermissions } from "../hooks/use-permissions";
import {
  integrationIdOfField,
  isStructuralCode,
  retryDecision,
  type MissingIntegrationFieldError,
} from "../lib/connection-choice";
import { refusalMessage } from "../lib/mutation-error";

interface MissingConnectionsModalProps {
  onClose: () => void;
  /** The 409's items, one per refused integration (`integrations.{packageId}`). */
  errors: MissingIntegrationFieldError[];
  /** The agent whose run 409'd; keys the server resolution each picker consumes. */
  agentPackageId: string;
  /** The version the refused launch ran: `required` (and so "no connection") is that version's. */
  version: string | undefined;
  /** The agent's tools/scopes per integration, so a new connection requests exactly those. */
  integrationEntries: AgentIntegrationEntry[] | undefined;
  /** Replays the refused launch. */
  onRetry: () => void;
  /** Disables the retry button while the new run is in flight. */
  retrying: boolean;
}

/**
 * Recovery surface for the run-kickoff `409 missing_integration_connection`: one row per
 * `errors[]` entry. An actionable row embeds `IntegrationConnectionPicker`, which shows the
 * connection the agent's resolution binds and writes the member's pin for this agent, as the
 * Connexions tab does. "Re-run" replays the launch without its own pick for the refused
 * integrations (`retryLaunch`), so a row shows exactly what the replay binds. Structural
 * failures keep a plain message: no pick fixes them.
 * Mounted only while a refusal stands, so it is always open.
 */
export function MissingConnectionsModal({
  onClose,
  errors,
  agentPackageId,
  version,
  integrationEntries,
  onRetry,
  retrying,
}: MissingConnectionsModalProps) {
  const { t } = useTranslation(["agents"]);
  // The live verdict of the launched version: a row it still blocks holds the re-run.
  const { data: readiness } = useAgentConnectionReadiness(agentPackageId, version);
  const stillBlocking = readiness && blockingIntegrationIds(readiness);

  const { showRetry, canRetry } = retryDecision(errors, retrying, stillBlocking);

  return (
    <Modal
      open
      onClose={onClose}
      title={t("missingConnections.title")}
      actions={
        <div className="flex items-center gap-2">
          {showRetry && (
            <Button onClick={onRetry} disabled={!canRetry} data-testid="missing-connections-retry">
              {retrying && <Spinner />}
              {t("missingConnections.retry")}
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
        {errors.map((err, i) => (
          <MissingRow
            key={`${err.field}-${i}`}
            err={err}
            agentPackageId={agentPackageId}
            version={version}
            integrationEntries={integrationEntries}
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
}: {
  err: MissingIntegrationFieldError;
  agentPackageId: string;
  version: string | undefined;
  integrationEntries: AgentIntegrationEntry[] | undefined;
}) {
  const { t } = useTranslation(["agents"]);
  const packageId = integrationIdOfField(err.field);
  const readsIntegrations = usePermissions().can("integrations:read");
  // Structural failures can't be fixed by connecting — an admin must activate
  // the integration, or the agent's dependency or configuration must change. No picker.
  const isStructural = isStructuralCode(err.code);

  // The server's verdict for the launched version, under the key the picker below reads it
  // from. The header follows it live: a connect, a renew or a `connection_update` event
  // invalidates the integration queries, this one refetches, and the header flips to resolved
  // without a manual Re-run.
  const { data: verdict } = useIntegrationReadinessEntry(
    isStructural ? undefined : packageId,
    agentPackageId,
    version,
  );
  const entry = integrationEntries?.find((e) => e.id === packageId);

  // Resolved = the run-kickoff gate lets this resolution through, and the replay binds this
  // same resolution (`retryLaunch` drops the launch's own pick). No verdict is not "ready".
  const resolved = !!verdict && !verdict.run_blocking;
  const unbound = unboundLabel(verdict?.resolution.warning ?? null);
  // The picker needs the manifest + first verdict to render fully wired; a
  // non-structural row holds a spinner until both land. Both reads gate on
  // `integrations:read`: without it neither lands, so the row names the
  // integration and waits for nothing.
  const pickable = !isStructural && readsIntegrations;
  const canRenderPicker = pickable && !!verdict;
  const loadingVerdict = pickable && !canRenderPicker;

  const displayName = useIntegrationName(packageId);
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
            {loadingVerdict ? (
              <Skeleton className="mt-1 h-3 w-24" />
            ) : (
              <div className={`flex items-start gap-1.5 text-xs ${colorClass}`}>
                <Icon className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 break-words">
                  {unbound ?? (resolved ? t("missingConnections.resolved") : message)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      {canRenderPicker && (
        <div className="border-border/60 mt-1 border-t pt-2">
          <IntegrationConnectionPicker
            integration={{ id: packageId, tools: entry?.tools, scopes: entry?.scopes }}
            agentPackageId={agentPackageId}
            version={version}
          />
        </div>
      )}
    </div>
  );
}
