// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@appstrate/ui/components/badge";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import type { DataColumn } from "../components/data-table";
import { rowActionsColumn } from "../components/row-actions-column";
import { TableRowActions } from "../components/table-row-actions";
import { CellDate, CellEmpty, CellText } from "../components/table-cells";
import type { ApiKeyInfo } from "../hooks/use-api-keys";
import { formatDateField } from "../lib/format-date";

function isApiKeyExpired(expiresAt: string | null | undefined): boolean {
  return expiresAt ? new Date(expiresAt) < new Date() : false;
}

type ScopeSummary = { kind: "full" } | { kind: "resources"; value: string };

function scopeSummary(key: ApiKeyInfo, availableScopes: string[] | undefined): ScopeSummary {
  if (
    availableScopes !== undefined &&
    key.scopes.length === availableScopes.length &&
    availableScopes.every((scope) => key.scopes.includes(scope))
  ) {
    return { kind: "full" };
  }
  return {
    kind: "resources",
    value: [...new Set(key.scopes.map((scope) => scope.split(":")[0]!))].join(", "),
  };
}

/** Comparable API-key facts stay in columns; only identity and actions survive on phones. */
export function useApiKeyColumns({
  availableScopes,
  revokingKeyId,
  onRevoke,
}: {
  availableScopes: string[] | undefined;
  revokingKeyId: string | null;
  /** Absent without `api-keys:revoke`: the row then has no menu. */
  onRevoke?: (key: ApiKeyInfo) => void;
}): DataColumn<ApiKeyInfo>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "name",
      header: t("spaces.nameLabel"),
      width: "minmax(104px,1.3fr)",
      cell: (key) => <CellText strong>{key.name}</CellText>,
    },
    {
      id: "prefix",
      header: t("spaces.metadataKey"),
      width: "88px",
      tier: 2,
      cell: (key) => <CellText mono>{key.keyPrefix}…</CellText>,
    },
    {
      id: "status",
      header: t("proxies.col.status"),
      width: "80px",
      tier: 2,
      cell: (key) =>
        isApiKeyExpired(key.expiresAt) ? (
          <Badge variant="failed">{t("apiKeys.expired")}</Badge>
        ) : (
          <Badge variant="success">{t("apiKeys.active")}</Badge>
        ),
    },
    {
      id: "expires",
      header: t("apiKeys.expirationColumn"),
      width: "96px",
      tier: 2,
      cell: (key) => (
        <span className="text-muted-foreground text-xs">
          {key.expiresAt ? formatDateField(key.expiresAt, "date") : t("apiKeys.expiresNever")}
        </span>
      ),
    },
    {
      id: "scopes",
      header: t("roles.permissionsLabel"),
      width: "minmax(112px,1.1fr)",
      tier: 3,
      cell: (key) => {
        const summary = scopeSummary(key, availableScopes);
        if (summary.kind === "full") return <CellText>{t("apiKeys.fullAccess")}</CellText>;
        return summary.value ? (
          <CellText title={summary.value}>{summary.value}</CellText>
        ) : (
          <CellEmpty />
        );
      },
    },
    {
      id: "lastUsed",
      header: t("apiKeys.lastUsedColumn"),
      width: "104px",
      align: "end",
      tier: 3,
      cell: (key) => <CellDate value={key.lastUsedAt} granularity="date" />,
    },
    {
      id: "createdBy",
      header: t("apiKeys.createdByColumn"),
      width: "minmax(96px,1fr)",
      tier: 3,
      cell: (key) =>
        key.created_by_name ? <CellText>{key.created_by_name}</CellText> : <CellEmpty />,
    },
    rowActionsColumn((key) => (
      <TableRowActions
        menuLabel={t("providers.moreActions", { name: key.name })}
        isPending={revokingKeyId === key.id}
        actions={[
          {
            id: "revoke",
            label: t("devices.revoke"),
            icon: Trash2,
            onSelect: () => onRevoke?.(key),
            destructive: true,
            hidden: !onRevoke,
          },
        ]}
      />
    )),
  ];
}
