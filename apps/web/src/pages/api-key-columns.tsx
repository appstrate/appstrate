// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../components/data-table";
import { TableRowActions } from "../components/table-row-actions";
import type { ApiKeyInfo } from "../hooks/use-api-keys";
import { formatDateField } from "../lib/markdown";

export function isApiKeyExpired(expiresAt: string | null | undefined): boolean {
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
  onRevoke: (key: ApiKeyInfo) => void;
}): DataColumn<ApiKeyInfo>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "name",
      header: t("apiKeys.nameLabel"),
      width: "minmax(104px,1.3fr)",
      cell: (key) => <span className="block truncate font-medium">{key.name}</span>,
    },
    {
      id: "prefix",
      header: t("apiKeys.keyColumn"),
      width: "88px",
      tier: 2,
      cell: (key) => (
        <span className="text-muted-foreground block truncate font-mono text-xs">
          {key.keyPrefix}…
        </span>
      ),
    },
    {
      id: "status",
      header: t("apiKeys.statusColumn"),
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
      header: t("apiKeys.permissionSummary"),
      width: "minmax(112px,1.1fr)",
      tier: 3,
      cell: (key) => {
        const summary = scopeSummary(key, availableScopes);
        return (
          <span
            className="text-muted-foreground block truncate text-xs"
            title={summary.kind === "resources" ? summary.value : undefined}
          >
            {summary.kind === "full" ? t("apiKeys.fullAccess") : summary.value || "—"}
          </span>
        );
      },
    },
    {
      id: "lastUsed",
      header: t("apiKeys.lastUsedColumn"),
      width: "104px",
      tier: 3,
      cell: (key) => (
        <span className="text-muted-foreground text-xs">
          {key.lastUsedAt ? formatDateField(key.lastUsedAt, "date") : "—"}
        </span>
      ),
    },
    {
      id: "createdBy",
      header: t("apiKeys.createdByColumn"),
      width: "minmax(96px,1fr)",
      tier: 3,
      cell: (key) => (
        <span className="text-muted-foreground block truncate text-xs">
          {key.created_by_name ?? "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "48px",
      align: "end",
      cell: (key) => (
        <TableRowActions
          menuLabel={t("apiKeys.moreActions", { name: key.name })}
          isPending={revokingKeyId === key.id}
          pendingLabel={t("common:loading")}
        >
          <DropdownMenuItem
            onSelect={() => onRevoke(key)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 />
            {t("apiKeys.revoke")}
          </DropdownMenuItem>
        </TableRowActions>
      ),
    },
  ];
}
