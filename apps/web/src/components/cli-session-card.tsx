// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Laptop, Terminal, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  categorizeUserAgent,
  deriveLabel,
  displayIp,
  type CliSessionDisplay,
  type UaCategory,
} from "../lib/cli-sessions";
import { formatDateField } from "../lib/markdown";

export interface CliSessionCardProps {
  session: CliSessionDisplay;
  /** Optional inline meta (e.g. "· user@example.com" on the admin variant). */
  meta?: ReactNode;
  /** Disable the revoke button. Caller passes its mutation pending state. */
  revokeDisabled?: boolean;
  onRevoke: () => void;
}

function DeviceIcon({ category }: { category: UaCategory }) {
  if (category === "cli") {
    return <Terminal className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />;
  }
  if (category === "github-action") {
    return <Monitor className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />;
  }
  return <Laptop className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />;
}

export function CliSessionCard({ session, meta, revokeDisabled, onRevoke }: CliSessionCardProps) {
  const { t } = useTranslation(["settings", "common"]);
  const category = categorizeUserAgent(session.userAgent);
  return (
    <div className="border-border bg-card flex items-start gap-4 rounded-lg border p-5">
      <DeviceIcon category={category} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{deriveLabel(session, t)}</span>
          {session.current && (
            <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-xs font-medium">
              {t("devices.thisDevice")}
            </span>
          )}
          {meta}
        </div>
        <div className="text-muted-foreground mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
          {session.userAgent && (
            <div className="truncate">
              <span className="font-medium">{t("devices.userAgentLabel")}:</span>{" "}
              <span className="font-mono">{session.userAgent}</span>
            </div>
          )}
          {displayIp(session.createdIp) && (
            <div>
              <span className="font-medium">{t("devices.createdIpLabel")}:</span>{" "}
              <span className="font-mono">{displayIp(session.createdIp)}</span>
            </div>
          )}
          <div>
            <span className="font-medium">{t("devices.createdAtLabel")}:</span>{" "}
            {formatDateField(session.createdAt)}
          </div>
          <div>
            <span className="font-medium">{t("devices.lastUsedLabel")}:</span>{" "}
            {session.lastUsedAt ? formatDateField(session.lastUsedAt) : t("devices.neverUsed")}
          </div>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRevoke}
        disabled={session.current || revokeDisabled}
      >
        {t("devices.revoke")}
      </Button>
    </div>
  );
}
