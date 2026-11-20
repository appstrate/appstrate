// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import type { DataColumn } from "./data-table";
import { AccessGrantIcon } from "./access-grant-icon";
import { DisabledReasonTooltip } from "./disabled-reason-tooltip";
import { TableRowActions } from "./table-row-actions";
import { rowActionsColumn } from "./row-actions-column";
import { CellDate, CellEmpty, CellText } from "./table-cells";
import {
  displayIp,
  grantHolderLabel,
  grantLabel,
  grantOriginLabel,
  grantTargetLabel,
  type AccessGrant,
  type OrgAccessGrant,
} from "../lib/access-grants";

/** A row of either list: the org-wide one adds its holder and `revocable`. */
export type AccessGrantRow = AccessGrant & Partial<Pick<OrgAccessGrant, "user" | "revocable">>;

interface ColumnOptions {
  /** The org-wide list names whose grant it is; a member's own list does not. */
  showHolder: boolean;
  revokingId: string | null;
  /** Absent without the right to end a grant: the row then has no menu. */
  onRevoke?: (grant: AccessGrantRow) => void;
}

function useHolderColumn(): DataColumn<AccessGrantRow> {
  const { t } = useTranslation(["settings", "common"]);
  return {
    id: "member",
    header: t("spaceMembers.colMember"),
    width: 60,
    elastic: true,
    cell: (grant) => {
      const label = grant.user ? grantHolderLabel(grant as OrgAccessGrant) : "";
      return <CellText title={label}>{label}</CellText>;
    },
  };
}

function useLastUsedColumn(): DataColumn<AccessGrantRow> {
  const { t } = useTranslation(["settings", "common"]);
  return {
    id: "lastUsed",
    header: t("devices.lastUsedLabel"),
    width: 170,
    align: "end",
    cell: (grant) =>
      grant.lastUsedAt ? (
        <CellDate value={grant.lastUsedAt} />
      ) : (
        <CellText>{t("devices.neverUsed")}</CellText>
      ),
  };
}

function useRevokeColumn({ revokingId, onRevoke }: ColumnOptions): DataColumn<AccessGrantRow> {
  const { t } = useTranslation(["settings", "common"]);
  return rowActionsColumn((grant: AccessGrantRow) => {
    if (!onRevoke) return null;
    const label = t("accessGrants.moreActions", { name: grantLabel(grant, t) });
    if (grant.revocable === false) {
      return (
        <DisabledReasonTooltip reason={t("accessGrants.notRevocableHere")}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-7 p-0"
            aria-label={label}
            disabled
          >
            <MoreHorizontal />
          </Button>
        </DisabledReasonTooltip>
      );
    }
    const isPending = revokingId === grant.id;
    return (
      <TableRowActions
        menuLabel={label}
        isPending={isPending}
        actions={[
          {
            id: "revoke",
            label: t("devices.revoke"),
            icon: Trash2,
            onSelect: () => onRevoke(grant),
            disabled: isPending,
            destructive: true,
          },
        ]}
      />
    );
  });
}

/** MCP client grants: which client, what it reaches, when it last acted. */
export function useMcpGrantColumns(options: ColumnOptions): DataColumn<AccessGrantRow>[] {
  const { t } = useTranslation(["settings", "common"]);
  const holder = useHolderColumn();
  const lastUsed = useLastUsedColumn();
  const revoke = useRevokeColumn(options);
  return [
    {
      id: "client",
      header: t("accessGrants.clientColumn"),
      width: 150,
      elastic: true,
      identity: true,
      cell: (grant) => {
        const name = grantLabel(grant, t);
        const origin = grantOriginLabel(grant, t);
        const second =
          grant.session_count > 1
            ? `${origin} · ${t("accessGrants.sessionCount", { count: grant.session_count })}`
            : origin;
        // The client's user agent rides on the name's hover: it identifies the
        // client again, and a column of it would squeeze the origin out.
        const nameTitle = [t("accessGrants.declaredName", { name }), grant.user_agent]
          .filter(Boolean)
          .join("\n");
        return (
          <div className="flex min-w-0 items-center gap-2">
            <AccessGrantIcon grant={grant} />
            <div className="min-w-0">
              <CellText strong title={nameTitle}>
                {name}
              </CellText>
              <CellText title={second}>{second}</CellText>
            </div>
          </div>
        );
      },
    },
    ...(options.showHolder ? [holder] : []),
    {
      id: "target",
      header: t("accessGrants.targetColumn"),
      width: 110,
      elastic: true,
      cell: (grant) => {
        const target = grantTargetLabel(grant, t);
        return <CellText title={target}>{target}</CellText>;
      },
    },
    {
      id: "created",
      header: t("accessGrants.authorizedAtLabel"),
      width: 150,
      align: "end",
      cell: (grant) => <CellDate value={grant.createdAt} />,
    },
    lastUsed,
    revoke,
  ];
}

/** CLI and GitHub Action sessions: one per device. */
export function useCliGrantColumns(options: ColumnOptions): DataColumn<AccessGrantRow>[] {
  const { t } = useTranslation(["settings", "common"]);
  const holder = useHolderColumn();
  const lastUsed = useLastUsedColumn();
  const revoke = useRevokeColumn(options);
  return [
    {
      id: "device",
      header: t("orgCliSessions.deviceColumn"),
      width: 150,
      elastic: true,
      identity: true,
      cell: (grant) => {
        const name = grantLabel(grant, t);
        return (
          <div className="flex min-w-0 items-center gap-2">
            <AccessGrantIcon grant={grant} />
            <div className="min-w-0">
              <CellText strong title={name}>
                {name}
              </CellText>
              {grant.user_agent ? (
                <CellText mono title={grant.user_agent}>
                  {grant.user_agent}
                </CellText>
              ) : null}
            </div>
          </div>
        );
      },
    },
    ...(options.showHolder ? [holder] : []),
    {
      id: "ip",
      header: t("devices.createdIpLabel"),
      width: 140,
      cell: (grant) => {
        const ip = displayIp(grant.created_ip);
        return ip ? <CellText mono>{ip}</CellText> : <CellEmpty />;
      },
    },
    {
      id: "created",
      header: t("devices.createdAtLabel"),
      width: 150,
      align: "end",
      cell: (grant) => <CellDate value={grant.createdAt} />,
    },
    lastUsed,
    revoke,
  ];
}
