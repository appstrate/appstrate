// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { CheckCircle2, FlaskConical, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../../components/data-table";
import type { OrgProxyInfo } from "../../hooks/use-proxies";
import type { TestResult } from "../../hooks/use-connection-test";
import { TestResultSpan } from "../../components/test-result-span";
import { TableRowActions } from "../../components/table-row-actions";

/**
 * The proxy column set. A proxy has no page of its own: a click on a custom
 * row opens its edit modal, and every action lives in the last column — which is why it has no header: a
 * column the reader cannot be told about is a column they cannot hide.
 */
export function useProxyColumns({
  testingIds,
  testResults,
  settingDefaultId,
  onTest,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  testingIds: ReadonlySet<string>;
  testResults: Record<string, TestResult | null>;
  settingDefaultId: string | null;
  onTest: (id: string) => void;
  /** Each absent without its permission, and its menu entry with it. */
  onEdit?: (p: OrgProxyInfo) => void;
  onDelete?: (p: OrgProxyInfo) => void;
  onSetDefault?: (p: OrgProxyInfo) => void;
}): DataColumn<OrgProxyInfo>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "proxy",
      header: t("proxies.col.name"),
      width: "minmax(80px,1.3fr)",
      cell: (p) => (
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium">{p.label}</span>
          {testResults[p.id] && (
            <div className="@xl/table:hidden">
              <TestResultSpan
                result={testResults[p.id]!}
                successKey="proxies.testSuccess"
                failedKey="proxies.testFailed"
              />
            </div>
          )}
        </div>
      ),
    },
    {
      id: "url",
      header: t("proxies.col.url"),
      width: "minmax(72px,1.5fr)",
      tier: 2,
      cell: (p) => (
        <span className="text-muted-foreground block truncate font-mono text-[0.65rem]">
          {p.urlPrefix}
        </span>
      ),
    },
    {
      id: "type",
      header: t("proxies.col.type"),
      width: "72px",
      tier: 2,
      cell: (p) => (
        <span className="text-muted-foreground block truncate text-xs">
          {p.source === "built-in" ? t("source.builtIn") : t("source.custom")}
        </span>
      ),
    },
    {
      id: "status",
      header: t("proxies.col.status"),
      width: "minmax(56px,0.8fr)",
      tier: 2,
      cell: (p) =>
        testResults[p.id] ? (
          <TestResultSpan
            result={testResults[p.id]!}
            successKey="proxies.testSuccess"
            failedKey="proxies.testFailed"
          />
        ) : (
          <Badge variant={p.enabled ? "success" : "secondary"}>
            {p.enabled ? t("proxies.active") : t("proxies.disabled")}
          </Badge>
        ),
    },
    {
      id: "default",
      header: t("proxies.col.default"),
      width: "96px",
      tier: 2,
      cell: (p) =>
        p.is_default ? (
          <Badge variant="success">{t("proxies.default")}</Badge>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        ),
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (p) => {
        const isTesting = testingIds.has(p.id);
        const isSettingDefault = settingDefaultId === p.id;
        const isCustom = p.source !== "built-in";
        return (
          <div className="relative z-10 flex min-w-0 items-center justify-end gap-1">
            <TableRowActions
              menuLabel={t("proxies.moreActions", { name: p.label })}
              isPending={isTesting || isSettingDefault}
            >
              {isCustom && onEdit && (
                <DropdownMenuItem onSelect={() => onEdit(p)}>
                  <Pencil />
                  {t("proxies.edit")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => onTest(p.id)} disabled={isTesting}>
                <FlaskConical />
                {t("proxies.test")}
              </DropdownMenuItem>
              {!p.is_default && onSetDefault && (
                <DropdownMenuItem
                  onSelect={() => onSetDefault(p)}
                  disabled={settingDefaultId !== null}
                  data-testid={`set-default-proxy-${p.id}`}
                >
                  <CheckCircle2 />
                  {t("proxies.setDefault")}
                </DropdownMenuItem>
              )}
              {isCustom && onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onDelete(p)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 />
                    {t("proxies.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </TableRowActions>
          </div>
        );
      },
    },
  ];
}
