// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { usePermissions } from "../../hooks/use-permissions";
import {
  useProxies,
  useCreateProxy,
  useUpdateProxy,
  useDeleteProxy,
  useSetDefaultProxy,
  useTestProxy,
} from "../../hooks/use-proxies";
import { useConnectionTest } from "../../hooks/use-connection-test";
import { ProxyFormModal } from "../../components/proxy-form-modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { Spinner } from "../../components/spinner";
import type { OrgProxyInfo, TestResult } from "@appstrate/shared-types";

function TestResultSpan({
  result,
  successKey,
  failedKey,
}: {
  result: TestResult;
  successKey: string;
  failedKey: string;
}) {
  const { t } = useTranslation(["settings"]);
  return (
    <span className={`text-sm ${result.ok ? "text-green-500" : "text-destructive"}`}>
      {result.ok
        ? t(successKey, { latency: result.latency })
        : t(failedKey, { message: result.message })}
    </span>
  );
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

  if (!isAdmin) return <Navigate to="/org-settings/general" replace />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const onCreate = () => {
    setEditProxy(null);
    setProxyModalOpen(true);
  };
  const onEdit = (p: OrgProxyInfo) => {
    setEditProxy(p);
    setProxyModalOpen(true);
  };
  const onDelete = (p: OrgProxyInfo) => setConfirmState({ label: p.label, id: p.id });
  const onSetDefault = (p: OrgProxyInfo) => setDefaultMutation.mutate(p.id);
  const onRemoveDefault = () => setDefaultMutation.mutate(null);

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button onClick={onCreate}>{t("proxies.add")}</Button>
      </div>

      {proxies && proxies.length > 0 ? (
        <div className="flex flex-col gap-3">
          {proxies.map((p) => {
            const isBuiltIn = p.source === "built-in";
            return (
              <div key={p.id} className="border-border bg-card rounded-lg border p-5">
                <div className="mb-3 flex items-center gap-3">
                  <div className="flex-1">
                    <h3 className="text-[0.95rem] font-semibold">{p.label}</h3>
                    <span className="text-muted-foreground text-sm">{p.urlPrefix}</span>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {p.isDefault && <Badge variant="success">{t("proxies.default")}</Badge>}
                      {isBuiltIn && (
                        <Badge variant="secondary" className="opacity-60">
                          {t("proxies.builtIn")}
                        </Badge>
                      )}
                      {!isBuiltIn && (
                        <Badge variant="secondary" className="opacity-60">
                          {p.enabled ? t("proxies.enabled") : t("proxies.disabled")}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <div className="border-border mt-3 flex items-center justify-end gap-2 border-t pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(p.id)}
                    disabled={testingId === p.id}
                  >
                    {testingId === p.id ? <Spinner /> : t("proxies.test")}
                  </Button>
                  {testResults[p.id] && (
                    <TestResultSpan
                      result={testResults[p.id]!}
                      successKey="proxies.testSuccess"
                      failedKey="proxies.testFailed"
                    />
                  )}
                  {p.isDefault && !isBuiltIn && (
                    <Button variant="outline" size="sm" onClick={onRemoveDefault}>
                      {t("proxies.removeDefault")}
                    </Button>
                  )}
                  {!p.isDefault && !isBuiltIn && (
                    <Button variant="outline" size="sm" onClick={() => onSetDefault(p)}>
                      {t("proxies.setDefault")}
                    </Button>
                  )}
                  {!isBuiltIn && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => onEdit(p)}>
                        {t("proxies.edit")}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => onDelete(p)}>
                        {t("proxies.delete")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
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
              { id: editProxy.id, data },
              { onSuccess: () => setProxyModalOpen(false) },
            );
          } else {
            createMutation.mutate(data, { onSuccess: () => setProxyModalOpen(false) });
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
            deleteMutation.mutate(confirmState.id, {
              onSuccess: () => setConfirmState(null),
            });
          }
        }}
      />
    </>
  );
}
