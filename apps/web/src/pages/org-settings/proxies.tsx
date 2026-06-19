// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Globe, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
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
import { useConnectionTest } from "../../hooks/use-connection-test";
import { ProxyFormModal } from "../../components/proxy-form-modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { Spinner } from "../../components/spinner";
import { TestResultSpan } from "../../components/test-result-span";
import { SourceBadge } from "../../components/source-badge";
import { DefaultCell } from "../../components/default-cell";

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

  if (!isAdmin) return <Navigate to="/org-settings/general" replace />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

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

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button onClick={onCreate}>{t("proxies.add")}</Button>
      </div>

      {proxies && proxies.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">{t("proxies.col.source")}</TableHead>
                <TableHead className="text-xs">{t("proxies.col.proxy")}</TableHead>
                <TableHead className="text-xs">{t("proxies.col.default")}</TableHead>
                <TableHead className="w-px text-right text-xs">
                  {t("proxies.col.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proxies.map((p) => {
                const isBuiltIn = p.source === "built-in";
                return (
                  <TableRow key={p.id} data-testid={`proxy-row-${p.id}`}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SourceBadge source={p.source} />
                        {!isBuiltIn && !p.enabled && (
                          <Badge variant="secondary" className="opacity-60">
                            {t("proxies.disabled")}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{p.label}</div>
                        <div className="text-muted-foreground font-mono text-[0.65rem]">
                          {p.urlPrefix}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <DefaultCell
                        isDefault={p.isDefault}
                        defaultLabel={t("proxies.default")}
                        setLabel={t("proxies.setDefault")}
                        onSetDefault={() => onSetDefault(p)}
                        testId={`set-default-proxy-${p.id}`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
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
                          onClick={() => handleTest(p.id)}
                          disabled={testingId === p.id}
                        >
                          {testingId === p.id ? <Spinner /> : t("proxies.test")}
                        </Button>
                        {!isBuiltIn && (
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
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState message={t("proxies.empty")} icon={Globe} compact>
          <Button onClick={onCreate}>{t("proxies.add")}</Button>
        </EmptyState>
      )}

      <ProxyFormModal
        open={proxyModalOpen}
        onClose={() => setProxyModalOpen(false)}
        proxy={editProxy}
        isPending={createMutation.isPending || updateMutation.isPending}
        onSubmit={(data) => {
          if (editProxy) {
            updateMutation.mutate(
              { params: { path: { id: editProxy.id } }, body: data },
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
