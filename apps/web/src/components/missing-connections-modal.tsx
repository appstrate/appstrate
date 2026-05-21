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
 * `{ integrationId: { authKey: connectionId } }` map.
 */

export interface MissingIntegrationFieldError {
  field: string; // `integrations.{packageId}` or `integrations.{packageId}.{authKey}`
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
  /** Required scopes — populated on insufficient_scopes for the OAuth re-consent. */
  requiredScopes?: string[];
  /** Candidate connection ids — populated on must_choose_connection. */
  candidateConnectionIds?: string[];
}

export type ConnectionOverridesMap = Record<string, Record<string, string>>;

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
  const pickedCount = Object.values(picks).reduce((sum, m) => sum + Object.keys(m).length, 0);

  const pickFor = (integrationId: string, authKey: string): string | undefined =>
    picks[integrationId]?.[authKey];

  const setPick = (integrationId: string, authKey: string, connectionId: string) => {
    setPicks((prev) => ({
      ...prev,
      [integrationId]: { ...(prev[integrationId] ?? {}), [authKey]: connectionId },
    }));
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
  pickFor: (integrationId: string, authKey: string) => string | undefined;
  onPick?: (integrationId: string, authKey: string, connectionId: string) => void;
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

  // Pick the auth to act on. The field carries it for needs_reconnection /
  // insufficient_scopes / must_choose_connection. For not_connected the
  // field is integration-level — fall back to the first oauth2 / first
  // declared (mirrors the AgentIntegrationsBlock heuristic).
  const targetAuthKey = authKey ?? pickDefaultAuth(detail?.manifest.auths);
  const displayName = detail?.manifest.displayName ?? packageId;
  const candidateIds = err.candidateConnectionIds ?? [];
  const candidates = (connections ?? []).filter((c) => candidateIds.includes(c.id));
  const pickedId = isMustChoose && authKey ? pickFor(packageId, authKey) : undefined;

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
            {...(err.requiredScopes ? { scopes: err.requiredScopes } : {})}
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
              const accountLabel =
                (c.identityClaims?.accountEmail as string | undefined) ??
                (c.identityClaims?.account_email as string | undefined) ??
                c.accountId;
              const isPicked = c.id === pickedId;
              const clickable = !!onPick && !!authKey;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={
                      clickable && authKey ? () => onPick!(packageId, authKey, c.id) : undefined
                    }
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
                    {c.label && <span className="truncate font-medium">{c.label}</span>}
                    <span className="text-muted-foreground truncate">{accountLabel}</span>
                    {c.sharedWithOrg && (
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
