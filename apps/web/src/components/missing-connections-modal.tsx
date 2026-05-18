// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, XCircle, ExternalLink, Puzzle } from "lucide-react";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";

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
  const { t } = useTranslation(["agents"]);
  const { packageId, authKey } = parseField(err.field);
  const isReconnect = err.code === "needs_reconnection" || err.code === "insufficient_scopes";
  const Icon = isReconnect ? AlertTriangle : XCircle;
  const colorClass = isReconnect ? "text-amber-500" : "text-destructive";
  const detailPath = toDetailPath(packageId);

  return (
    <div className="border-border bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Puzzle className="text-muted-foreground size-4 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{packageId}</div>
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
      <Button asChild size="sm">
        <Link to={detailPath}>
          {isReconnect ? t("detail.integrationFix") : t("detail.integrationConnect")}
          <ExternalLink className="ml-1 size-3" />
        </Link>
      </Button>
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

function toDetailPath(packageId: string): string {
  const slash = packageId.indexOf("/", 1);
  if (slash < 0) return `/integrations/${encodeURIComponent(packageId)}`;
  return `/integrations/${encodeURIComponent(packageId.slice(0, slash))}/${encodeURIComponent(packageId.slice(slash + 1))}`;
}
