// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Plus } from "lucide-react";
import { DataTable } from "../../components/data-table";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import type { PageAction } from "../../components/page-actions-menu";
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
import { useConnectionTest } from "../../hooks/use-connection-test";
import { useModalParam, useModalTarget } from "../../hooks/use-modal-param";
import { ProxyFormModal } from "../../components/proxy-form-modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { EmptyState, EmptyStateAction } from "../../components/page-states";
import { useProxyColumns } from "./proxy-columns";

export function OrgSettingsProxiesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const canWrite = can("proxies:write");
  const canDelete = can("proxies:delete");

  const [confirmState, setConfirmState] = useState<{ label: string; id: string } | null>(null);

  const { data: proxies, isLoading, error } = useProxies();
  const newProxy = useModalParam("newProxy");
  const editParam = useModalTarget("editProxy", proxies);
  const editProxy = editParam.target ?? null;
  // Opened by its trigger's rule too, not just by the URL: a built-in proxy is not editable.
  const proxyModalOpen =
    canWrite &&
    (newProxy.value !== null || (editProxy !== null && editProxy.source !== "built-in"));
  const closeProxyModal = editProxy ? editParam.close : newProxy.close;
  const createMutation = useCreateProxy();
  const updateMutation = useUpdateProxy();
  const deleteMutation = useDeleteProxy();
  const setDefaultMutation = useSetDefaultProxy();
  const testMutation = useTestProxy();
  const { testingIds, testResults, handleTest } = useConnectionTest(testMutation);

  const create: PageAction = {
    id: "create",
    icon: Plus,
    label: t("proxies.add"),
    onSelect: () => newProxy.open(),
    hidden: !canWrite,
  };
  const onEdit = (p: OrgProxyInfo) => editParam.open(p.id);
  const onDelete = (p: OrgProxyInfo) => setConfirmState({ label: p.label, id: p.id });
  const onSetDefault = (p: OrgProxyInfo) => setDefaultMutation.mutate({ body: { proxyId: p.id } });
  const columns = useProxyColumns({
    testingIds,
    testResults,
    onTest: handleTest,
    onEdit: canWrite ? onEdit : undefined,
    onDelete: canDelete ? onDelete : undefined,
    onSetDefault: canWrite ? onSetDefault : undefined,
    settingDefaultId: setDefaultMutation.isPending
      ? (setDefaultMutation.variables?.body.proxyId ?? null)
      : null,
  });

  return (
    <>
      {/* The page's own action, in the treatment every list bar uses: a white
          surface, not a filled blue. A screen whose table now looks like every
          other table cannot keep the one button that does not. */}
      <SettingsPageActions actions={[create]} />

      <DataTable
        tableId="proxies"
        label={t("proxies.tabTitle")}
        columns={columns}
        rows={proxies ?? []}
        rowKey={(p) => p.id}
        rowAction={canWrite ? onEdit : undefined}
        rowActionable={(p) => p.source !== "built-in"}
        rowLabel={(p) => t("proxies.editNamed", { name: p.label })}
        isLoading={isLoading}
        failure={error}
        empty={
          <EmptyState message={t("proxies.empty")} icon={Globe} compact>
            <EmptyStateAction action={create} />
          </EmptyState>
        }
      />

      {proxyModalOpen && (
        <ProxyFormModal
          key={editProxy?.id ?? "__create__"}
          onClose={closeProxyModal}
          proxy={editProxy}
          isPending={createMutation.isPending || updateMutation.isPending}
          onSubmit={(data) => {
            if (editProxy) {
              // The credential-bearing URL is never returned to the client, so the
              // edit form starts blank. An empty field means "keep the current
              // URL" — omit it entirely (`url` is optional on PATCH); sending `""`
              // fails the server's `z.url()` and 400s a label-only edit.
              updateMutation.mutate(
                {
                  params: { path: { id: editProxy.id } },
                  body: data.url ? data : { label: data.label },
                },
                {
                  onSuccess: closeProxyModal,
                },
              );
            } else {
              createMutation.mutate(
                { body: data },
                {
                  onSuccess: closeProxyModal,
                },
              );
            }
          }}
        />
      )}

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("proxies.deleteTitle")}
        confirmLabel={t("btn.delete", { ns: "common" })}
        description={confirmState ? t("proxies.deleteConfirm", { label: confirmState.label }) : ""}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (confirmState) {
            deleteMutation.mutate(
              { params: { path: { id: confirmState.id } } },
              {
                onSuccess: () => setConfirmState(null),
              },
            );
          }
        }}
      />
    </>
  );
}
