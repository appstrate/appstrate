// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import type { DataColumn } from "../../components/data-table";
import { CliSessionIcon } from "../../components/cli-session-icon";
import { TableRowActions } from "../../components/table-row-actions";
import { rowActionsColumn } from "../../components/row-actions-column";
import { CellDate, CellEmpty, CellText } from "../../components/table-cells";
import { deriveLabel, displayIp, type CliSessionDisplay } from "../../lib/cli-sessions";

export interface AdminCliSession extends CliSessionDisplay {
  userId: string;
  userEmail: string | null;
  userName: string | null;
}

export function cliSessionUserLabel(session: AdminCliSession): string {
  return session.userName || session.userEmail || session.userId;
}

export function useCliSessionColumns({
  revokingFamilyId,
  onRevoke,
}: {
  revokingFamilyId: string | null;
  /** Absent without `cli-sessions:delete`: the row then has no menu. */
  onRevoke?: (session: AdminCliSession) => void;
}): DataColumn<AdminCliSession>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "device",
      header: t("orgCliSessions.deviceColumn"),
      width: "minmax(80px,1.3fr)",
      cell: (session) => (
        <div className="flex min-w-0 items-center gap-2">
          <CliSessionIcon userAgent={session.userAgent} />
          <span className="block truncate text-sm font-medium" title={deriveLabel(session, t)}>
            {deriveLabel(session, t)}
          </span>
        </div>
      ),
    },
    {
      id: "member",
      header: t("orgCliSessions.memberColumn"),
      width: "minmax(60px,1fr)",
      tier: 2,
      cell: (session) => (
        <CellText title={cliSessionUserLabel(session)}>{cliSessionUserLabel(session)}</CellText>
      ),
    },
    {
      id: "status",
      header: t("orgCliSessions.statusColumn"),
      width: "minmax(60px,0.7fr)",
      tier: 2,
      cell: (session) =>
        session.current ? (
          <Badge variant="running">{t("orgCliSessions.current")}</Badge>
        ) : (
          <CellEmpty />
        ),
    },
    {
      id: "userAgent",
      header: t("devices.userAgentLabel"),
      width: "minmax(96px,1fr)",
      tier: 2,
      cell: (session) =>
        session.userAgent ? (
          <CellText mono title={session.userAgent}>
            {session.userAgent}
          </CellText>
        ) : (
          <CellEmpty />
        ),
    },
    {
      id: "ip",
      header: t("devices.createdIpLabel"),
      width: "110px",
      tier: 3,
      cell: (session) => {
        const ip = displayIp(session.createdIp);
        return ip ? <CellText mono>{ip}</CellText> : <CellEmpty />;
      },
    },
    {
      id: "created",
      header: t("devices.createdAtLabel"),
      width: "100px",
      align: "end",
      tier: 3,
      cell: (session) => <CellDate value={session.createdAt} granularity="date" />,
    },
    {
      id: "lastUsed",
      header: t("devices.lastUsedLabel"),
      width: "120px",
      align: "end",
      tier: 2,
      cell: (session) =>
        session.lastUsedAt ? (
          <CellDate value={session.lastUsedAt} granularity="date" />
        ) : (
          <CellText>{t("devices.neverUsed")}</CellText>
        ),
    },
    rowActionsColumn((session: AdminCliSession) => {
      const revoke = onRevoke;
      if (!revoke) return null;
      const isPending = revokingFamilyId === session.familyId;
      return (
        <TableRowActions
          menuLabel={t("orgCliSessions.moreActions", { device: deriveLabel(session, t) })}
          isPending={isPending}
          actions={[
            {
              id: "revoke",
              label: t("devices.revoke"),
              icon: Trash2,
              onSelect: () => revoke(session),
              disabled: session.current || isPending,
              destructive: true,
            },
          ]}
        />
      );
    }),
  ];
}
