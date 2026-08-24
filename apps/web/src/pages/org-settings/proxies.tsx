// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CheckCircle2, FlaskConical, Globe, Plus, Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import { DataTable, type DataColumn } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { TOOLBAR_ACTION } from "../../lib/toolbar-button";
import { usePermissions } from "../../hooks/use-permissions";
import {
  useProxies,
  useCreateProxy,
  useUpdateProxy,
  useDeleteProxy,
  useSetDefaultProxy,
  useTestProxy,
  type OrgProxyInfo,
} from "../../hooks/use-proxies";
import { getErrorMessage } from "@appstrate/core/errors";
import { useConnectionTest, type TestResult } from "../../hooks/use-connection-test";
import { ProxyFormModal } from "../../components/proxy-form-modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { ErrorState, EmptyState } from "../../components/page-states";
import { TestResultSpan } from "../../components/test-result-span";
import { TableRowActions } from "../../components/table-row-actions";
import { NavigateKeepingState } from "../../components/navigate-keeping-state";

/**
 * The proxy column set. A proxy has no page of its own, so the row is static
 * and the actions live in the last column — which is why it has no header: a
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
  onEdit: (p: OrgProxyInfo) => void;
  onDelete: (p: OrgProxyInfo) => void;
  onSetDefault: (p: OrgProxyInfo) => void;
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
              primary={
                isCustom ? { label: t("proxies.edit"), onSelect: () => onEdit(p) } : undefined
              }
              menuLabel={t("proxies.moreActions", { name: p.label })}
              isPending={isTesting || isSettingDefault}
              pendingLabel={t("common:loading")}
            >
              <DropdownMenuItem onSelect={() => onTest(p.id)} disabled={isTesting}>
                <FlaskConical />
                {t("proxies.test")}
              </DropdownMenuItem>
              {!p.is_default && (
                <DropdownMenuItem
                  onSelect={() => onSetDefault(p)}
                  disabled={settingDefaultId !== null}
                  data-testid={`set-default-proxy-${p.id}`}
                >
                  <CheckCircle2 />
                  {t("proxies.setDefault")}
                </DropdownMenuItem>
              )}
              {isCustom && (
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

export function OrgSettingsProxiesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();

  const [proxyModalOpen, setProxyModalOpen] = useState(false);
  const [editProxy, setEditProxy] = useState<OrgProxyInfo | null>(null);
  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);

  const { data: proxies, isLoading, error } = useProxies();
  const createMutation = useCreateProxy();
  const updateMutation = useUpdateProxy();
  const deleteMutation = useDeleteProxy();
  const setDefaultMutation = useSetDefaultProxy();
  const testMutation = useTestProxy();
  const { testingIds, testResults, handleTest } = useConnectionTest(testMutation);

  const onCreate = () => {
    setEditProxy(null);
    setProxyModalOpen(true);
  };
  const onEdit = (p: OrgProxyInfo) => {
    setEditProxy(p);
    setProxyModalOpen(true);
  };
  const onDelete = (p: OrgProxyInfo) => setConfirmState({ label: p.label, id: p.id });
  const onSetDefault = (p: OrgProxyInfo) => setDefaultMutation.mutate({ body: { proxyId: p.id } });
  const columns = useProxyColumns({
    testingIds,
    testResults,
    onTest: handleTest,
    onEdit,
    onDelete,
    onSetDefault,
    settingDefaultId: setDefaultMutation.isPending
      ? (setDefaultMutation.variables?.body.proxyId ?? null)
      : null,
  });

  // Every hook first, THEN the guard: the column set is a hook now, and a
  // return above it makes the call conditional.
  if (!isAdmin) return <NavigateKeepingState to="/org-settings/general" />;

  return (
    <>
      {/* The page's own action, in the treatment every list bar uses: a white
          surface, not a filled blue. A screen whose table now looks like every
          other table cannot keep the one button that does not. */}
      <SettingsPageActions>
        <Button variant="outline" size="sm" className={TOOLBAR_ACTION} onClick={onCreate}>
          <Plus />
          {t("proxies.add")}
        </Button>
      </SettingsPageActions>

      <DataTable
        label={t("proxies.tabTitle")}
        columns={columns}
        rows={proxies ?? []}
        rowKey={(p) => p.id}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
        // No action of its own: the button above the table is the same one, and
        // it does not go away when the list is empty.
        empty={<EmptyState message={t("proxies.empty")} icon={Globe} compact />}
      />

      <ProxyFormModal
        open={proxyModalOpen}
        onClose={() => setProxyModalOpen(false)}
        proxy={editProxy}
        isPending={createMutation.isPending || updateMutation.isPending}
        onSubmit={(data) => {
          if (editProxy) {
            // The credential-bearing URL is never returned to the client, so the
            // edit form starts blank. An empty field means "keep the current
            // URL" — omit it entirely (`url` is optional on PUT); sending `""`
            // fails the server's `z.url()` and 400s a label-only edit.
            updateMutation.mutate(
              {
                params: { path: { id: editProxy.id } },
                body: data.url ? data : { label: data.label },
              },
              {
                onSuccess: () => setProxyModalOpen(false),
                onError: (error) => toast.error(getErrorMessage(error)),
              },
            );
          } else {
            createMutation.mutate(
              { body: data },
              {
                onSuccess: () => setProxyModalOpen(false),
                onError: (error) => toast.error(getErrorMessage(error)),
              },
            );
          }
        }}
      />

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={confirmState ? t("proxies.deleteConfirm", { label: confirmState.label }) : ""}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (confirmState) {
            deleteMutation.mutate(
              { params: { path: { id: confirmState.id } } },
              {
                onSuccess: () => setConfirmState(null),
                onError: (error) => toast.error(getErrorMessage(error)),
              },
            );
          }
        }}
      />
    </>
  );
}
