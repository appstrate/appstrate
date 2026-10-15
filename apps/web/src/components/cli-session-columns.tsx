// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@appstrate/ui/components/badge";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import type { DataColumn } from "./data-table";
import { CliSessionIcon } from "./cli-session-icon";
import { TableRowActions } from "./table-row-actions";
import { rowActionsColumn } from "./row-actions-column";
import { CellDate, CellEmpty, CellText } from "./table-cells";
import { deriveLabel, displayIp, type CliSessionDisplay } from "../lib/cli-sessions";

/** A CLI session row; the member fields come with the org-wide list only. */
export interface CliSessionRow extends CliSessionDisplay {
  userId?: string;
  userEmail?: string | null;
  userName?: string | null;
}

export function cliSessionUserLabel(session: CliSessionRow): string {
  return session.userName || session.userEmail || session.userId || "";
}

export function useCliSessionColumns({
  showMember = true,
  revokingFamilyId,
  onRevoke,
}: {
  /** The org-wide list names whose session it is; a member's own list does not. */
  showMember?: boolean;
  revokingFamilyId: string | null;
  /** Absent without `cli-sessions:delete`: the row then has no menu. */
  onRevoke?: (session: CliSessionRow) => void;
}): DataColumn<CliSessionRow>[] {
  const { t } = useTranslation(["settings", "common"]);

  const memberColumn: DataColumn<CliSessionRow> = {
    id: "member",
    header: t("spaceMembers.colMember"),
    width: 60,
    elastic: true,
    tier: 2,
    cell: (session) => (
      <CellText title={cliSessionUserLabel(session)}>{cliSessionUserLabel(session)}</CellText>
    ),
  };

  return [
    {
      id: "device",
      header: t("orgCliSessions.deviceColumn"),
      width: 80,
      elastic: true,
      cell: (session) => (
        <div className="flex min-w-0 items-center gap-2">
          <CliSessionIcon userAgent={session.userAgent} />
          <span
            className="block min-w-0 truncate text-sm font-medium"
            title={deriveLabel(session, t)}
          >
            {deriveLabel(session, t)}
          </span>
          {session.current && <Badge variant="running">{t("orgCliSessions.current")}</Badge>}
        </div>
      ),
    },
    ...(showMember ? [memberColumn] : []),
    {
      id: "userAgent",
      header: t("devices.userAgentLabel"),
      width: 96,
      elastic: true,
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
      width: 110,
      tier: 3,
      cell: (session) => {
        const ip = displayIp(session.createdIp);
        return ip ? <CellText mono>{ip}</CellText> : <CellEmpty />;
      },
    },
    {
      id: "created",
      header: t("devices.createdAtLabel"),
      width: 150,
      align: "end",
      tier: 3,
      cell: (session) => <CellDate value={session.createdAt} />,
    },
    {
      id: "lastUsed",
      header: t("devices.lastUsedLabel"),
      width: 150,
      align: "end",
      tier: 2,
      cell: (session) =>
        session.lastUsedAt ? (
          <CellDate value={session.lastUsedAt} />
        ) : (
          <CellText>{t("devices.neverUsed")}</CellText>
        ),
    },
    rowActionsColumn((session: CliSessionRow) => {
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
