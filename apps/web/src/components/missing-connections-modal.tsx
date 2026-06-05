// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, XCircle, Puzzle, Users, Check, Loader2 } from "lucide-react";
import type { AgentIntegrationEntry } from "@appstrate/shared-types";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "./spinner";
import { InlineConnectButton } from "./integration-connect/inline-connect-button";
import { connectionDisplayLabel } from "./integration-connect/connection-label";
import {
  resolveAction,
  resolutionBlocksRun,
} from "./integration-connect/integration-run-readiness";
import { useIntegrationDetail, useIntegrationAgentResolution } from "../hooks/use-integrations";

/**
 * Recovery surface for the run-kickoff 412 emitted by
 * `validateAgentReadiness` when integration connections are missing. The
 * 412 ships every failing `(integration, auth)` pair on `errors[]`;
 * this modal renders one row per entry with a CTA to the integration
 * detail page (where the actor can connect or re-consent). The same
 * data drives the inline Connexions tab, but a user who hits Run on a
 * stale page needs an explicit pointer to where the gap is.
 *
 * For `must_choose_connection` rows (#199 fallback with N>1 candidates),
 * the row renders a clickable picker; selections accumulate in modal
 * state and the footer's "Re-run with picks" button fires the parent's
 * `onRetryWithOverrides` callback with the full
 * `{ integrationId: connectionId }` flat map (mechanism #2).
 */

export interface MissingIntegrationFieldError {
  field: string; // `integrations.{packageId}` (integration-level — auth_key lives on the candidate row)
  code:
    | "not_connected"
    | "needs_reconnection"
    | "insufficient_scopes"
    | "must_choose_connection"
    | "package_not_found"
    | "not_installed_or_invalid_manifest"
    | "integration_not_active"
    | string;
  title?: string;
  message: string;
  /** Missing scopes — populated on insufficient_scopes for the OAuth re-consent upgrade. */
  missing_scopes?: string[];
  /** Candidate connection ids — populated on must_choose_connection. */
  candidateConnectionIds?: string[];
  /**
   * The dead/under-scoped connection id — populated on `needs_reconnection`
   * and `insufficient_scopes`. Forwarded to `InlineConnectButton.connectionId`
   * so the OAuth callback UPDATEs the existing row instead of INSERTing a
   * duplicate (single-writer contract in `integration-connections.ts`).
   */
  connection_id?: string;
}

/**
 * Per-run connection picks, flat map keyed by integration id. Matches the
 * wire format the run route expects on `connection_overrides` (mechanism #2,
 * validated by `input-parser.ts`: `Record<integrationId, connectionId>`). The
 * chosen connection carries its own `auth_key`; storing it twice would let
 * the two diverge.
 */
export type ConnectionOverridesMap = Record<string, string>;

interface MissingConnectionsModalProps {
  open: boolean;
  onClose: () => void;
  errors: MissingIntegrationFieldError[];
  /**
   * The agent whose run 412'd. Keys the per-integration server resolution
   * (`GET /agent-resolution/:agentId`) each row consumes so its status + CTA
   * stay in lockstep with the Connexions tab and never re-derive from the
   * static 412 payload. Omitted only by callers without the agent in context.
   */
  agentPackageId?: string;
  /**
   * The agent's declared integration entries (tools/scopes per integration).
   * Forwarded to the connect CTA so a fresh connection requests exactly the
   * scopes THIS agent needs (avoids an immediate insufficient_scopes re-run).
   */
  integrationEntries?: AgentIntegrationEntry[];
  /** Re-run with the picked overrides (drives the must_choose picker). */
  onRetryWithOverrides: (overrides: ConnectionOverridesMap) => void;
  /** Disables the retry button while the new run is in flight. */
  retrying?: boolean;
}

export function MissingConnectionsModal({
  open,
  onClose,
  errors,
  agentPackageId,
  integrationEntries,
  onRetryWithOverrides,
  retrying,
}: MissingConnectionsModalProps) {
  const { t } = useTranslation(["agents"]);
  const [picks, setPicks] = useState<ConnectionOverridesMap>({});

  const integrationErrors = errors.filter((e) => e.field.startsWith("integrations."));
  const mustChooseCount = integrationErrors.filter(
    (e) => e.code === "must_choose_connection",
  ).length;
  const pickedCount = Object.keys(picks).length;

  const pickFor = (integrationId: string): string | undefined => picks[integrationId];

  const setPick = (integrationId: string, connectionId: string) => {
    setPicks((prev) => ({ ...prev, [integrationId]: connectionId }));
  };

  // A `needs_reconnection` / `insufficient_scopes` / `not_connected` modal has
  // no must_choose picks, so it previously offered only a Close button — the
  // user had to dismiss the modal and re-run by hand after fixing a connection.
  // Surface the same Re-run here for any actionable row. must_choose still gates
  // on a complete pick set; the others just re-fire the run (a fresh 412 keeps
  // the modal open with the updated error list).
  const hasActionable = integrationErrors.some(
    (e) =>
      e.code === "must_choose_connection" ||
      e.code === "needs_reconnection" ||
      e.code === "insufficient_scopes" ||
      e.code === "not_connected",
  );
  const showRetry = hasActionable;
  const canRetry = !retrying && (mustChooseCount === 0 || pickedCount === mustChooseCount);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("missingConnections.title")}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onClose} disabled={retrying}>
            {t("missingConnections.close")}
          </Button>
          {showRetry && (
            <Button
              onClick={() => onRetryWithOverrides(picks)}
              disabled={!canRetry}
              data-testid="must-choose-retry"
            >
              {retrying && <Spinner />}
              {mustChooseCount > 0
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
            integrationEntries={integrationEntries}
            pickFor={pickFor}
            onPick={setPick}
          />
        ))}
      </div>
    </Modal>
  );
}

function MissingRow({
  err,
  agentPackageId,
  integrationEntries,
  pickFor,
  onPick,
}: {
  err: MissingIntegrationFieldError;
  agentPackageId?: string;
  integrationEntries?: AgentIntegrationEntry[];
  pickFor: (integrationId: string) => string | undefined;
  onPick: (integrationId: string, connectionId: string) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const packageId = parseField(err.field);
  const { data: detail } = useIntegrationDetail(packageId);
  const isMustChoose = err.code === "must_choose_connection";
  // Structural failures (integration not active in the app, package missing
  // or invalid manifest) can't be fixed by connecting — an admin must
  // activate the integration or the agent must drop the dependency. Suppress
  // the connect CTA so the user isn't sent into a guaranteed failure.
  const isStructural =
    err.code === "integration_not_active" ||
    err.code === "package_not_found" ||
    err.code === "not_installed_or_invalid_manifest";

  // Server-authoritative verdict — the SAME `IntegrationAgentResolution` the
  // Connexions tab card and the launch-readiness badge consume. The row no
  // longer re-derives status/CTA from the static 412 payload, so the three
  // surfaces can never disagree and the row updates live: the connect/renew
  // flow invalidates the `["integrations", …]` prefix (OAuth popup close,
  // fields-connect success, `connection_update` SSE), which this query sits
  // under, so it refetches and the row flips to resolved without a manual
  // Re-run. must_choose still recovers through the picker + Re-run below.
  const { data: resolution } = useIntegrationAgentResolution(
    isStructural ? undefined : packageId,
    isStructural ? undefined : agentPackageId,
  );
  const entry = integrationEntries?.find((e) => e.id === packageId);
  const action =
    resolution && detail && !isMustChoose
      ? resolveAction(resolution, detail.manifest, entry?.tools, entry?.scopes)
      : null;
  // Resolved = the run-kickoff gate would no longer reject this integration.
  // Single predicate shared with the badge, so resolved here ⇔ not blocking there.
  const resolved = !!resolution && !isMustChoose && !resolutionBlocksRun(resolution);
  // Awaiting the first verdict (non-structural, non-must_choose rows): hold the
  // CTA until we know whether it's a connect / reconnect / upgrade.
  const loadingVerdict = !isStructural && !isMustChoose && !resolution;

  const isReconnect = action?.intent === "reconnect" || action?.intent === "upgrade";
  const Icon = resolved ? Check : isMustChoose ? Users : isReconnect ? AlertTriangle : XCircle;
  const colorClass = resolved
    ? "text-emerald-600"
    : isMustChoose
      ? "text-amber-500"
      : isReconnect
        ? "text-amber-500"
        : "text-destructive";

  const displayName = detail?.manifest.display_name ?? packageId;
  // must_choose candidates come from the live verdict (own + shared accessible
  // connections), not the 412 snapshot — the picker stays accurate as the set
  // changes. Falls back to the 412-supplied ids until the verdict lands.
  const candidateIds = err.candidateConnectionIds ?? [];
  const candidates = (resolution?.candidates ?? []).filter(
    (c) => candidateIds.length === 0 || candidateIds.includes(c.id),
  );
  const pickedId = isMustChoose ? pickFor(packageId) : undefined;

  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-md border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Puzzle className="text-muted-foreground size-4 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{displayName}</div>
            <div className={`flex items-center gap-1.5 truncate text-xs ${colorClass}`}>
              <Icon className="size-3" />
              <span className="truncate">
                {resolved ? t("missingConnections.resolved") : err.message}
              </span>
            </div>
          </div>
        </div>
        {loadingVerdict ? (
          <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
        ) : (
          !isMustChoose &&
          !isStructural &&
          !resolved &&
          action && (
            <InlineConnectButton
              packageId={packageId}
              authKey={action.authKey}
              intent={action.intent}
              {...(action.scopes ? { scopes: action.scopes } : {})}
              {...(action.intent !== "connect" && action.connectionId
                ? { connectionId: action.connectionId, lockToAuthKey: true }
                : {})}
            />
          )
        )}
      </div>
      {isMustChoose && candidates.length > 0 && (
        <div className="border-border/60 mt-1 border-t pt-2">
          <p className="text-muted-foreground mb-1.5 text-[0.7rem]">
            {t("missingConnections.mustChoose.pickPrompt", { count: candidates.length })}
          </p>
          <ul className="space-y-1">
            {candidates.map((c) => {
              const name = connectionDisplayLabel(c);
              const isPicked = c.id === pickedId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onPick(packageId, c.id)}
                    className={
                      "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition " +
                      (isPicked
                        ? "border-primary bg-primary/10 border"
                        : "bg-muted/40 hover:bg-muted cursor-pointer")
                    }
                    data-testid={`must-choose-candidate-${c.id}`}
                  >
                    {isPicked && <Check className="text-primary size-3 shrink-0" />}
                    <span className="truncate font-medium">{name}</span>
                    {c.shared_with_org && (
                      <Badge variant="secondary" className="text-[0.6rem]">
                        {t("missingConnections.mustChoose.sharedBadge")}
                      </Badge>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Extract the integration package id from the `integrations.{packageId}` field path. */
function parseField(field: string): string {
  return field.slice("integrations.".length);
}
