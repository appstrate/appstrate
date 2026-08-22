// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Globe, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { DataTable, type DataColumn } from "../../components/data-table";
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
import { Spinner } from "../../components/spinner";
import { TestResultSpan } from "../../components/test-result-span";
import { SourceBadge } from "../../components/source-badge";
import { DefaultCell } from "../../components/default-cell";

/**
 * The proxy column set. A proxy has no page of its own, so the row is static
 * and the actions live in the last column — which is why it has no header: a
 * column the reader cannot be told about is a column they cannot hide.
 */
export function useProxyColumns({
  testingId,
  testResults,
  onTest,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  testingId: string | null;
  testResults: Record<string, TestResult | null>;
  onTest: (id: string) => void;
  onEdit: (p: OrgProxyInfo) => void;
  onDelete: (p: OrgProxyInfo) => void;
  onSetDefault: (p: OrgProxyInfo) => void;
}): DataColumn<OrgProxyInfo>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "proxy",
      header: t("proxies.col.proxy"),
      width: "minmax(180px,1.6fr)",
      cell: (p) => (
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{p.label}</span>
            {/* The badges belong with the name, like the models table: they are
                attributes of one proxy, not a dimension read down the table,
                and a column of their own does not fit the settings modal. */}
            <SourceBadge source={p.source} />
            {p.source !== "built-in" && !p.enabled && (
              <Badge variant="secondary" className="opacity-60">
                {t("proxies.disabled")}
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground truncate font-mono text-[0.65rem]">
            {p.urlPrefix}
          </div>
        </div>
      ),
    },
    {
      id: "default",
      header: t("proxies.col.default"),
      width: "120px",
      tier: 2,
      cell: (p) => (
        <DefaultCell
          isDefault={p.is_default}
          defaultLabel={t("proxies.default")}
          setLabel={t("proxies.setDefault")}
          onSetDefault={() => onSetDefault(p)}
          testId={`set-default-proxy-${p.id}`}
        />
      ),
    },
    {
      id: "actions",
      header: "",
      width: "168px",
      align: "end",
      cell: (p) => (
        <div className="relative z-10 flex items-center justify-end gap-1">
          {testResults[p.id] && (
            <TestResultSpan
              result={testResults[p.id]!}
              successKey="proxies.testSuccess"
              failedKey="proxies.testFailed"
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onTest(p.id)}
            disabled={testingId === p.id}
          >
            {testingId === p.id ? <Spinner /> : t("proxies.test")}
          </Button>
          {p.source !== "built-in" && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => onEdit(p)}
                aria-label={t("proxies.edit")}
              >
                <Pencil size={14} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => onDelete(p)}
                aria-label={t("proxies.delete")}
              >
                <Trash2 size={14} className="text-destructive" />
              </Button>
            </>
          )}
        </div>
      ),
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
  const { testingId, testResults, handleTest } = useConnectionTest(testMutation);

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
    testingId,
    testResults,
    onTest: handleTest,
    onEdit,
    onDelete,
    onSetDefault,
  });

  // Every hook first, THEN the guard: the column set is a hook now, and a
  // return above it makes the call conditional.
  if (!isAdmin) return <Navigate to="/org-settings/general" replace />;

  return (
    <>
      {/* The page's own action, in the treatment every list bar uses: a white
          surface, not a filled blue. A screen whose table now looks like every
          other table cannot keep the one button that does not. */}
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" className={TOOLBAR_ACTION} onClick={onCreate}>
          <Plus />
          {t("proxies.add")}
        </Button>
      </div>

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
              { onSuccess: () => setProxyModalOpen(false) },
            );
          } else {
            createMutation.mutate({ body: data }, { onSuccess: () => setProxyModalOpen(false) });
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
              { onSuccess: () => setConfirmState(null) },
            );
          }
        }}
      />
    </>
  );
}
