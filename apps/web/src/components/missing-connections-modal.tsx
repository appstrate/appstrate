// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { AlertTriangle, XCircle, Puzzle } from "lucide-react";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { InlineConnectButton } from "./integration-connect/inline-connect-button";
import { useIntegrationDetail } from "../hooks/use-integrations";

/**
 * Phase C — recovery surface for the run-kickoff 412 emitted by
 * validateAgentIntegrations. The 412 ships every failing
 * `(integration, auth)` pair on `errors[]`; this modal renders one row
 * per entry with a CTA to the integration detail page (where the actor
 * can connect or re-consent). The same data drives the inline
 * Connexions tab (Phase B), but a user who hits Run on a stale page
 * needs an explicit pointer to where the gap is.
 */

export interface MissingIntegrationFieldError {
  field: string; // `integrations.{packageId}` or `integrations.{packageId}.{authKey}`
  code:
    | "not_connected"
    | "needs_reconnection"
    | "insufficient_scopes"
    | "package_not_found"
    | "not_installed_or_invalid_manifest"
    | string;
  title?: string;
  message: string;
  /** Required scopes — populated on insufficient_scopes for the OAuth re-consent. */
  requiredScopes?: string[];
}

interface MissingConnectionsModalProps {
  open: boolean;
  onClose: () => void;
  errors: MissingIntegrationFieldError[];
}

export function MissingConnectionsModal({ open, onClose, errors }: MissingConnectionsModalProps) {
  const { t } = useTranslation(["agents"]);

  const integrationErrors = errors.filter((e) => e.field.startsWith("integrations."));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("missingConnections.title")}
      actions={
        <Button variant="outline" onClick={onClose}>
          {t("missingConnections.close")}
        </Button>
      }
    >
      <p className="text-muted-foreground mb-3 text-sm">{t("missingConnections.intro")}</p>
      <div className="space-y-2">
        {integrationErrors.map((err, i) => (
          <MissingRow key={`${err.field}-${i}`} err={err} />
        ))}
      </div>
    </Modal>
  );
}

function MissingRow({ err }: { err: MissingIntegrationFieldError }) {
  const { packageId, authKey } = parseField(err.field);
  const { data: detail } = useIntegrationDetail(packageId);
  const isReconnect = err.code === "needs_reconnection" || err.code === "insufficient_scopes";
  const Icon = isReconnect ? AlertTriangle : XCircle;
  const colorClass = isReconnect ? "text-amber-500" : "text-destructive";

  // Pick the auth to act on. The field carries it for needs_reconnection /
  // insufficient_scopes. For not_connected the field is integration-level —
  // fall back to the first oauth2 / first declared (mirrors the
  // AgentIntegrationsBlock heuristic).
  const targetAuthKey = authKey ?? pickDefaultAuth(detail?.manifest.auths);
  const displayName = detail?.manifest.displayName ?? packageId;

  return (
    <div className="border-border bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2">
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
      {targetAuthKey && (
        <InlineConnectButton
          packageId={packageId}
          authKey={targetAuthKey}
          {...(err.requiredScopes ? { scopes: err.requiredScopes } : {})}
          intent={isReconnect ? "fix" : "connect"}
        />
      )}
    </div>
  );
}

function pickDefaultAuth(auths: Record<string, { type: string }> | undefined): string | null {
  if (!auths) return null;
  const keys = Object.keys(auths);
  if (keys.length === 0) return null;
  const oauth = keys.find((k) => auths[k]?.type === "oauth2");
  return oauth ?? keys[0]!;
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
