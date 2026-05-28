// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
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
  /**
   * Re-run with the picked overrides. Only required to enable the
   * must_choose picker — when omitted, the picker falls back to a
   * read-only "Manage connections" link.
   */
  onRetryWithOverrides?: (overrides: ConnectionOverridesMap) => void;
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

  const canRetry =
    !!onRetryWithOverrides && mustChooseCount > 0 && pickedCount === mustChooseCount && !retrying;

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
          {onRetryWithOverrides && mustChooseCount > 0 && (
            <Button
              onClick={() => onRetryWithOverrides(picks)}
              disabled={!canRetry}
              data-testid="must-choose-retry"
            >
              {retrying && <Spinner />}
              {t("missingConnections.mustChoose.retry")}
            </Button>
          )}
        </div>
      }
    >
      <p className="text-muted-foreground mb-3 text-sm">{t("missingConnections.intro")}</p>
      <div className="space-y-2">
        {integrationErrors.map((err, i) => (
          <MissingRow
            key={`${err.field}-${i}`}
            err={err}
            pickFor={pickFor}
            onPick={onRetryWithOverrides ? setPick : undefined}
          />
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
  onPick?: (integrationId: string, connectionId: string) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const { packageId, authKey } = parseField(err.field);
  const { data: detail } = useIntegrationDetail(packageId);
  const isMustChooseCode = err.code === "must_choose_connection";
  // Only fetch the connection list when we need to render the picker — saves
  // an extra round trip on the common not_connected / needs_reconnection rows.
  const { data: connections } = useIntegrationConnections(isMustChooseCode ? packageId : undefined);
  const isReconnect = err.code === "needs_reconnection" || err.code === "insufficient_scopes";
  const isMustChoose = err.code === "must_choose_connection";
  // Structural failures (integration not active in the app, package missing
  // or invalid manifest) can't be fixed by connecting — an admin must
  // activate the integration or the agent must drop the dependency. Suppress
  // the connect CTA so the user isn't sent into a guaranteed failure.
  const isStructural =
    err.code === "integration_not_active" ||
    err.code === "package_not_found" ||
    err.code === "not_installed_or_invalid_manifest";
  const Icon = isMustChoose ? Users : isReconnect ? AlertTriangle : XCircle;
  const colorClass = isMustChoose
    ? "text-amber-500"
    : isReconnect
      ? "text-amber-500"
      : "text-destructive";

  // Pick the auth to act on. `field` is now integration-level only — the
  // legacy `integrations.{id}.{authKey}` form is parsed back-compat but no
  // longer emitted. The chosen connection carries its own `auth_key`; we
  // only need an authKey for the reconnect/upgrade/connect CTA (to drive
  // the OAuth method), which falls back to the manifest default.
  const targetAuthKey = authKey ?? pickDefaultAuth(detail?.manifest.auths);
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
              <span className="truncate">{err.message}</span>
              {authKey && (
                <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
                  {authKey}
                </span>
              )}
            </div>
          </div>
        </div>
        {!isMustChoose && !isStructural && targetAuthKey && (
          <InlineConnectButton
            packageId={packageId}
            authKey={targetAuthKey}
            {...(err.missing_scopes ? { scopes: err.missing_scopes } : {})}
            {...(err.connection_id ? { connectionId: err.connection_id } : {})}
            intent={
              err.code === "insufficient_scopes"
                ? "upgrade"
                : err.code === "needs_reconnection"
                  ? "reconnect"
                  : "connect"
            }
          />
        )}
        {isMustChoose && !onPick && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/integrations/${packageId}`}>{t("missingConnections.mustChoose.cta")}</Link>
          </Button>
        )}
      </div>
      {isMustChoose && candidates.length > 0 && (
        <div className="border-border/60 mt-1 border-t pt-2">
          <p className="text-muted-foreground mb-1.5 text-[0.7rem]">
            {onPick
              ? t("missingConnections.mustChoose.pickPrompt", { count: candidates.length })
              : t("missingConnections.mustChoose.candidates", { count: candidates.length })}
          </p>
          <ul className="space-y-1">
            {candidates.map((c) => {
              const name = connectionDisplayLabel(c);
              const isPicked = c.id === pickedId;
              const clickable = !!onPick;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={clickable ? () => onPick!(packageId, c.id) : undefined}
                    disabled={!clickable}
                    className={
                      "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition " +
                      (isPicked
                        ? "border-primary bg-primary/10 border"
                        : clickable
                          ? "bg-muted/40 hover:bg-muted cursor-pointer"
                          : "bg-muted/40 cursor-default")
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

function parseField(field: string): { packageId: string; authKey: string | null } {
  // `integrations.@scope/name` or `integrations.@scope/name.authKey`
  const tail = field.slice("integrations.".length);
  // packageId always starts with `@scope/name` — split on the last `.` AFTER
  // the slash so the auth-key parser doesn't trip on the scope's `@`.
  const slashIdx = tail.indexOf("/");
  if (slashIdx < 0) return { packageId: tail, authKey: null };
  const afterSlash = tail.slice(slashIdx + 1);
  const dotIdx = afterSlash.indexOf(".");
  if (dotIdx < 0) return { packageId: tail, authKey: null };
  return {
    packageId: tail.slice(0, slashIdx + 1 + dotIdx),
    authKey: afterSlash.slice(dotIdx + 1),
  };
}
