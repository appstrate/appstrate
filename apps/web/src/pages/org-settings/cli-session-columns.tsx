// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../../components/data-table";
import { CliSessionIcon } from "../../components/cli-session-icon";
import { TableRowActions } from "../../components/table-row-actions";
import { deriveLabel, displayIp, type CliSessionDisplay } from "../../lib/cli-sessions";
import { formatDateField } from "../../lib/markdown";

export interface AdminCliSession extends CliSessionDisplay {
  userId: string;
  userEmail: string | null;
  userName: string | null;
}

export function memberLabel(session: AdminCliSession): string {
  return session.userName || session.userEmail || session.userId;
}

export function useCliSessionColumns({
  revokingFamilyId,
  onRevoke,
}: {
  revokingFamilyId: string | null;
  onRevoke: (session: AdminCliSession) => void;
}): DataColumn<AdminCliSession>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "device",
      header: t("orgCliSessions.deviceColumn"),
      width: "minmax(160px,1.5fr)",
      cell: (session) => (
        <div className="flex min-w-0 items-start gap-2">
          <CliSessionIcon userAgent={session.userAgent} />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium">{deriveLabel(session, t)}</span>
              {session.current && <Badge variant="running">{t("devices.thisDevice")}</Badge>}
            </div>
            <div className="text-muted-foreground truncate text-xs">{memberLabel(session)}</div>
          </div>
        </div>
      ),
    },
    {
      id: "userAgent",
      header: t("devices.userAgentLabel"),
      width: "minmax(140px,1fr)",
      tier: 2,
      cell: (session) => (
        <span
          className="text-muted-foreground relative z-10 truncate font-mono text-xs"
          title={session.userAgent ?? ""}
        >
          {session.userAgent || "—"}
        </span>
      ),
    },
    {
      id: "ip",
      header: t("devices.createdIpLabel"),
      width: "110px",
      tier: 3,
      cell: (session) => (
        <span className="text-muted-foreground font-mono text-xs">
          {displayIp(session.createdIp) || "—"}
        </span>
      ),
    },
    {
      id: "created",
      header: t("devices.createdAtLabel"),
      width: "116px",
      align: "end",
      tier: 3,
      cell: (session) => (
        <span className="text-muted-foreground text-xs">
          {formatDateField(session.createdAt, "date")}
        </span>
      ),
    },
    {
      id: "lastUsed",
      header: t("devices.lastUsedLabel"),
      width: "116px",
      align: "end",
      tier: 2,
      cell: (session) => (
        <span className="text-muted-foreground text-xs">
          {session.lastUsedAt
            ? formatDateField(session.lastUsedAt, "date")
            : t("devices.neverUsed")}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "48px",
      align: "end",
      cell: (session) => {
        const isPending = revokingFamilyId === session.familyId;
        return (
          <TableRowActions
            menuLabel={t("orgCliSessions.moreActions", { device: deriveLabel(session, t) })}
            isPending={isPending}
            pendingLabel={t("common:loading")}
          >
            <DropdownMenuItem
              onSelect={() => onRevoke(session)}
              disabled={session.current || isPending}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 />
              {t("devices.revoke")}
            </DropdownMenuItem>
          </TableRowActions>
        );
      },
    },
  ];
}
