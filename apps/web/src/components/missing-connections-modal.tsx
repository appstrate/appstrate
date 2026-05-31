// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, XCircle, Puzzle, Users, Check } from "lucide-react";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "./spinner";
import { InlineConnectButton } from "./integration-connect/inline-connect-button";
import { pickDefaultAuth } from "./integration-connect/pick-default-auth";
import { connectionDisplayLabel } from "./integration-connect/connection-label";
import { useIntegrationDetail, useIntegrationConnections } from "../hooks/use-integrations";

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
  /** Re-run with the picked overrides (drives the must_choose picker). */
  onRetryWithOverrides: (overrides: ConnectionOverridesMap) => void;
  /** Disables the retry button while the new run is in flight. */
  retrying?: boolean;
}

export function MissingConnectionsModal({
  open,
  onClose,
  errors,
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
      <div className="space-y-2">
        {integrationErrors.map((err, i) => (
          <MissingRow key={`${err.field}-${i}`} err={err} pickFor={pickFor} onPick={setPick} />
        ))}
      </div>
    </Modal>
  );
}

function MissingRow({
  err,
  pickFor,
  onPick,
}: {
  err: MissingIntegrationFieldError;
  pickFor: (integrationId: string) => string | undefined;
  onPick: (integrationId: string, connectionId: string) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const packageId = parseField(err.field);
  const { data: detail } = useIntegrationDetail(packageId);
  const isMustChoose = err.code === "must_choose_connection";
  const isReconnect = err.code === "needs_reconnection" || err.code === "insufficient_scopes";
  // Fetch the connection list when we render the must_choose picker, or when a
  // reconnect/upgrade row needs the dead connection's own auth_key to bind a
  // single (non-dropdown) renew button to the right method. Still skipped on the
  // common not_connected rows (no connection_id), saving a round trip there.
  const needsConnections = isMustChoose || (isReconnect && !!err.connection_id);
  const { data: connections, refetch: refetchConnections } = useIntegrationConnections(
    needsConnections ? packageId : undefined,
  );
  // The dead/under-scoped connection this row acts on (when known).
  const reconnectConn = err.connection_id
    ? (connections ?? []).find((c) => c.id === err.connection_id)
    : undefined;
  // The row clears itself live the moment the underlying connection is healthy
  // again: the renew flow forces a refetch (see `onConnected` below) and the
  // `connection_update` SSE / popup invalidation also refresh this list, so the
  // CTA flips to a resolved state without a manual re-run.
  //   • needs_reconnection → resolved once the flag is cleared.
  //   • insufficient_scopes (upgrade) → resolved once the granted scopes cover
  //     every previously-missing scope. The re-consent requests them
  //     explicitly, so they land literally in `scopes_granted` (a parent that
  //     only *implies* a missing child won't match — conservative, never a
  //     false "resolved").
  const resolved =
    !!reconnectConn &&
    (err.code === "needs_reconnection"
      ? !reconnectConn.needs_reconnection
      : err.code === "insufficient_scopes"
        ? !reconnectConn.needs_reconnection &&
          (err.missing_scopes ?? []).every((s) => reconnectConn.scopes_granted.includes(s))
        : false);
  // Structural failures (integration not active in the app, package missing
  // or invalid manifest) can't be fixed by connecting — an admin must
  // activate the integration or the agent must drop the dependency. Suppress
  // the connect CTA so the user isn't sent into a guaranteed failure.
  const isStructural =
    err.code === "integration_not_active" ||
    err.code === "package_not_found" ||
    err.code === "not_installed_or_invalid_manifest";
  const Icon = resolved ? Check : isMustChoose ? Users : isReconnect ? AlertTriangle : XCircle;
  const colorClass = resolved
    ? "text-success"
    : isMustChoose
      ? "text-warning"
      : isReconnect
        ? "text-warning"
        : "text-destructive";

  // Pick the auth to act on. `field` is integration-level (`integrations.{id}`);
  // the chosen connection carries its own `auth_key`. We only need an authKey
  // for the reconnect/upgrade/connect CTA (to drive the OAuth method). On a
  // reconnect/upgrade the dead connection already pins a method, so resolve its
  // auth_key for a single button bound to that method (no method-picker — there
  // is nothing to choose); fall back to the manifest default until the
  // connection list loads.
  const targetAuthKey = reconnectConn?.auth_key ?? pickDefaultAuth(detail?.manifest.auths);
  const displayName = detail?.manifest.display_name ?? packageId;
  const candidateIds = err.candidateConnectionIds ?? [];
  const candidates = (connections ?? []).filter((c) => candidateIds.includes(c.id));
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
        {!isMustChoose && !isStructural && !resolved && targetAuthKey && (
          <InlineConnectButton
            packageId={packageId}
            authKey={targetAuthKey}
            {...(err.missing_scopes ? { scopes: err.missing_scopes } : {})}
            {...(err.connection_id ? { connectionId: err.connection_id } : {})}
            {...(isReconnect ? { lockToAuthKey: true } : {})}
            intent={
              err.code === "insufficient_scopes"
                ? "upgrade"
                : err.code === "needs_reconnection"
                  ? "reconnect"
                  : "connect"
            }
            // Force this row's connection list to refetch the moment the renew
            // popup closes / a fields connect succeeds, so the row flips to its
            // resolved state immediately instead of waiting on a global cache
            // invalidation (or a page reload).
            onConnected={() => void refetchConnections()}
          />
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
