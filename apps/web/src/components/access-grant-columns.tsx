// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import type { DataColumn } from "./data-table";
import { AccessGrantIcon } from "./access-grant-icon";
import { TableRowActions } from "./table-row-actions";
import { rowActionsColumn } from "./row-actions-column";
import { CellDate, CellText } from "./table-cells";
import {
  grantHolderLabel,
  grantLabel,
  grantOriginLabel,
  grantTargetLabel,
  type AccessGrant,
  type OrgAccessGrant,
} from "../lib/access-grants";

interface ColumnOptions<T extends AccessGrant> {
  /** The org-wide list names whose grant it is; a member's own list does not. */
  showHolder: boolean;
  revokingId: string | null;
  /** Absent without the right to end a grant: the row then has no menu. */
  onRevoke?: (grant: T) => void;
}

function isOrgGrant(grant: AccessGrant): grant is OrgAccessGrant {
  return "user" in grant;
}

function useSharedColumns<T extends AccessGrant>({ revokingId, onRevoke }: ColumnOptions<T>) {
  const { t } = useTranslation(["settings", "common"]);
  const holder: DataColumn<T> = {
    id: "member",
    header: t("spaceMembers.colMember"),
    width: 140,
    elastic: true,
    cell: (grant) => {
      const label = isOrgGrant(grant) ? grantHolderLabel(grant) : "";
      return <CellText title={label}>{label}</CellText>;
    },
  };
  const lastUsed: DataColumn<T> = {
    id: "lastUsed",
    header: t("accessGrants.lastUsedLabel"),
    width: 170,
    align: "end",
    cell: (grant) => (
      <div className="min-w-0">
        {grant.lastUsedAt ? (
          <CellDate value={grant.lastUsedAt} />
        ) : (
          <CellText>{t("accessGrants.neverUsed")}</CellText>
        )}
        {grant.last_used_ip && <CellText mono>{grant.last_used_ip}</CellText>}
      </div>
    ),
  };
  const revoke = rowActionsColumn((grant: T) => {
    if (!onRevoke) return null;
    const isPending = revokingId === grant.id;
    return (
      <TableRowActions
        menuLabel={t("accessGrants.moreActions", { name: grantLabel(grant, t) })}
        isPending={isPending}
        disabledReason={
          isOrgGrant(grant) && !grant.revocable ? t("accessGrants.notRevocableHere") : undefined
        }
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
  return { holder, lastUsed, revoke };
}

/** MCP client grants: which client, what it reaches, when it last acted. */
export function useMcpGrantColumns<T extends AccessGrant>(
  options: ColumnOptions<T>,
): DataColumn<T>[] {
  const { t } = useTranslation(["settings", "common"]);
  const { holder, lastUsed, revoke } = useSharedColumns(options);
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
        return (
          <div className="flex min-w-0 items-center gap-2">
            <AccessGrantIcon grant={grant} />
            <div className="min-w-0">
              <CellText strong title={t("accessGrants.declaredName", { name })}>
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
        const target = grant.target ? grantTargetLabel(grant.target, t) : "";
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
export function useCliGrantColumns<T extends AccessGrant>(
  options: ColumnOptions<T>,
): DataColumn<T>[] {
  const { t } = useTranslation(["settings", "common"]);
  const { holder, lastUsed, revoke } = useSharedColumns(options);
  return [
    {
      id: "device",
      header: t("accessGrants.deviceColumn"),
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
              {grant.user_agent && (
                <CellText mono title={grant.user_agent}>
                  {grant.user_agent}
                </CellText>
              )}
            </div>
          </div>
        );
      },
    },
    ...(options.showHolder ? [holder] : []),
    {
      id: "created",
      header: t("accessGrants.signedInAtLabel"),
      width: 150,
      align: "end",
      cell: (grant) => <CellDate value={grant.createdAt} />,
    },
    lastUsed,
    revoke,
  ];
}
