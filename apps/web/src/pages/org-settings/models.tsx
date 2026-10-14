// SPDX-License-Identifier: Apache-2.0

/**
 * Settings › Models: the organization's providers, in two tabs. A connected provider makes its
 * models available (`lib/model-providers.ts`).
 *
 * - **Clés org**: the organization's keys, and the instance's own models. An organization key
 *   serves the models bound to it, the instance serves the ones it ships.
 * - **Clés perso**: the setting that lets people use a key or a subscription of their own, one
 *   row per service open to them (its models, and who plugged a key in), then the personal keys
 *   themselves, each with what the server lets the caller do with it (`allowed_actions`).
 *
 * A model's own deeds (test, delete, its finer settings) are in its form, opened from « Choose the
 * models »; the instance's models are tested from its row.
 *
 * The tab lives in the URL (`?tab=personal`), like the roles page's.
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { cn } from "@appstrate/ui/cn";
import { usePermissions } from "../../hooks/use-permissions";
import {
  useDeleteModel,
  useModels,
  useModelFormHandler,
  useSetDefaultModel,
  type OrgModelInfo,
} from "../../hooks/use-models";
import {
  useModelProviderCredentials,
  useProvidersRegistry,
  useUpdateModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../../hooks/use-model-provider-credentials";
import { useOrgSettings } from "../../hooks/use-org-settings";
import { NoAccessState } from "../../components/route-gate";
import { useModalParam, useModalTarget } from "../../hooks/use-modal-param";
import { ModelFormModal } from "../../components/model-form-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { DeleteKeyConfirm } from "../../components/delete-key-confirm";
import { ConfirmModal } from "../../components/confirm-modal";
import { CollectionTabs } from "../../components/collection-tabs";
import { PreferencesModelsLink } from "../../components/preferences-models-link";
import { EmptyStateAction } from "../../components/page-states";
import { ProvidersTable } from "../../components/providers-table";
import { PersonalServicesTable } from "../../components/personal-services-table";
import { ProviderAddFlow } from "../../components/provider-add-flow";
import { PersonalModelsModal, ProviderModelsModal } from "../../components/model-choice-dialog";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PersonalCredentialsSetting } from "../../components/settings/personal-credentials-setting";
import { SettingsGroup } from "../../components/settings/setting-row";
import { PageActionsMenu } from "../../components/page-actions-menu";
import { credentialUpdateBody } from "../../lib/personal-model-credentials";
import {
  isSystemModel,
  personalModelServices,
  personalServiceRows,
  providerRows,
  type ProviderRow,
} from "../../lib/model-providers";
import { authStore } from "../../stores/auth-store";

type ModelsTab = "org" | "personal";

export function OrgSettingsModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const userId = useStore(authStore, (s) => s.user?.id);

  const canWriteModels = can("models:write");
  const canDeleteModels = can("models:delete");
  const canReadCredentials = can("model-provider-credentials:read");
  const canWriteCredentials = can("model-provider-credentials:write");
  const canConnect = can("model-provider-credentials:connect");

  const { data: models, isLoading: modelsLoading, error: modelsError } = useModels();
  const { data: credentials, isLoading: pkLoading } = useModelProviderCredentials();
  const { data: registry } = useProvidersRegistry();
  const { data: orgSettings } = useOrgSettings();

  const addProvider = useModalParam("newCredential");
  const editKey = useModalTarget("editCredential", credentials);
  const chooseModels = useModalTarget("models", credentials);
  const personalModels = useModalParam("personalModels");
  // The form edits what a list offers: never a model the instance ships, which an id typed in
  // the URL would otherwise open.
  const editableModels = useMemo(() => models?.filter((m) => !isSystemModel(m)), [models]);
  const editModel = useModalTarget("editModel", editableModels);

  // The tab is a place: `?tab=personal` opens it, and the first one leaves the URL alone.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: ModelsTab = searchParams.get("tab") === "personal" ? "personal" : "org";
  const setTab = (next: ModelsTab) =>
    setSearchParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next === "org") out.delete("tab");
      else out.set("tab", next);
      return out;
    });

  const [confirmDelete, setConfirmDelete] = useState<ModelProviderCredentialInfo | null>(null);
  const [deletingModel, setDeletingModel] = useState<OrgModelInfo | null>(null);
  const updateCredential = useUpdateModelProviderCredential();
  const setDefault = useSetDefaultModel();
  const deleteModel = useDeleteModel();
  const modelForm = useModelFormHandler({
    editModel: editModel.target ?? null,
    onSuccess: editModel.close,
  });

  const { orgRows, personalRows } = useMemo(() => {
    const rows = providerRows(models ?? [], credentials ?? [], registry ?? [], userId);
    const isOrg = (row: ProviderRow) => row.kind === "org-key" || row.kind === "system";
    return { orgRows: rows.filter(isOrg), personalRows: rows.filter((row) => !isOrg(row)) };
  }, [models, credentials, registry, userId]);
  const serviceRows = useMemo(
    () => personalServiceRows(models ?? [], credentials ?? [], registry ?? [], userId),
    [models, credentials, registry, userId],
  );
  const personalServices = personalModelServices(registry ?? []);
  // « Open a service » starts on one that is not open yet.
  const nextService = (
    personalServices.find((s) => !serviceRows.some((r) => r.id === s.providerId)) ??
    personalServices[0]
  )?.providerId;

  const personalAllowed = orgSettings?.personal_model_credentials === true;
  // Known off: the table stays, greyed. Unknown (the setting did not load) is not off.
  const personalOff = orgSettings?.personal_model_credentials === false;

  if (!can("models:read")) return <NoAccessState />;

  /** A key's menu, the organization's or a person's: the row offers what the server allows. */
  const keyDeeds = {
    onRename: async (pk: ModelProviderCredentialInfo, label: string) => {
      // A refusal is toasted by the mutation cache; the rejection keeps the label being typed.
      await updateCredential.mutateAsync({ params: { path: { id: pk.id } }, body: { label } });
    },
    onChangeKey: (pk: ModelProviderCredentialInfo) => editKey.open(pk.id),
    onReconnect: (pk: ModelProviderCredentialInfo) => editKey.open(pk.id),
    onDelete: setConfirmDelete,
  };

  const emptyOrg = {
    message: t("providers.empty"),
    hint: canWriteCredentials ? undefined : t("providers.emptyAskAdmin"),
    action: canWriteCredentials ? (
      <EmptyStateAction label={t("credentials.add")} onClick={() => addProvider.open()} />
    ) : undefined,
  };

  return (
    <>
      {/* The deed of the tab in view; a member who may write nothing has no menu. */}
      {tab === "org" && canWriteCredentials && (
        <SettingsPageActions>
          <PageActionsMenu>
            <DropdownMenuItem
              data-page-action="create-credential"
              onSelect={() => addProvider.open()}
            >
              <Plus />
              {t("credentials.add")}
            </DropdownMenuItem>
          </PageActionsMenu>
        </SettingsPageActions>
      )}
      {tab === "personal" && canWriteModels && nextService && (
        <SettingsPageActions>
          <PageActionsMenu>
            <DropdownMenuItem
              data-page-action="open-personal-service"
              onSelect={() => personalModels.open(nextService)}
            >
              <Plus />
              {t("providers.allowPersonalModels")}
            </DropdownMenuItem>
          </PageActionsMenu>
        </SettingsPageActions>
      )}

      <div className="mb-6">
        <CollectionTabs
          value={tab}
          label={t("providers.tabTitle")}
          onChange={setTab}
          options={[
            { value: "org", label: t("providers.tabOrg") },
            { value: "personal", label: t("providers.tabPersonal") },
          ]}
        />
      </div>

      {tab === "org" && (
        <div className="mb-8">
          <ProvidersTable
            label={t("providers.tableLabel")}
            tableId="org-providers"
            rows={orgRows}
            isLoading={modelsLoading || (canReadCredentials && pkLoading)}
            error={modelsError}
            empty={emptyOrg}
            canWriteModels={canWriteModels}
            {...keyDeeds}
            onChooseModels={(pk) => chooseModels.open(pk.id)}
            onSetDefault={(m: OrgModelInfo) =>
              setDefault.mutate(
                { body: { modelId: m.id } },
                { onSuccess: () => toast.success(t("models.defaultSet", { name: m.label })) },
              )
            }
          />
        </div>
      )}

      {tab === "personal" && (
        <>
          {(can("org:settings") || canWriteModels) && (
            <SettingsGroup className="mb-6">
              <PersonalCredentialsSetting />
            </SettingsGroup>
          )}
          {personalOff && (
            <p className="text-muted-foreground mb-3 text-sm">{t("providers.personalOff")}</p>
          )}
          <div inert={personalOff} className={cn("mb-6", personalOff && "opacity-50")}>
            <PersonalServicesTable
              rows={serviceRows}
              isLoading={modelsLoading || (canReadCredentials && pkLoading)}
              error={modelsError}
              canWriteModels={canWriteModels}
              onChooseModels={(row) => personalModels.open(row.id)}
            />
          </div>
          {/* Outside the greyed table: a key already held is deleted whatever the setting says. */}
          {canReadCredentials && personalRows.length > 0 && (
            <section className="mb-6">
              <h3 className="mb-3 text-sm font-semibold">{t("providers.memberKeys")}</h3>
              <ProvidersTable
                label={t("providers.memberKeys")}
                tableId="member-providers"
                rows={personalRows}
                showType
                isLoading={false}
                error={null}
                empty={{ message: t("modelCredentials.empty") }}
                canWriteModels={false}
                {...keyDeeds}
              />
            </section>
          )}
          {canConnect && personalAllowed && (
            <p className="text-muted-foreground text-sm">
              {t("providers.personalFooter")}{" "}
              <PreferencesModelsLink>{t("providers.personalFooterLink")}</PreferencesModelsLink>
            </p>
          )}
        </>
      )}

      {addProvider.value !== null && (
        <ProviderAddFlow credentials={credentials ?? []} onClose={addProvider.close} />
      )}

      <CredentialFormModal
        open={editKey.target !== undefined}
        onClose={editKey.close}
        credential={editKey.target ?? null}
        isPending={updateCredential.isPending}
        onSubmit={(data) => {
          const target = editKey.target;
          if (!target) return;
          // The PATCH body only accepts mutable fields: the protocol and endpoint are pinned
          // by `providerId` at create time.
          updateCredential.mutate(
            { params: { path: { id: target.id } }, body: credentialUpdateBody(target, data) },
            { onSuccess: editKey.close },
          );
        }}
      />

      {chooseModels.target && (
        <ProviderModelsModal
          credential={chooseModels.target}
          onClose={chooseModels.close}
          // The model form replaces the list: two never stack.
          onAdvanced={(id) => editModel.open(id, "models")}
        />
      )}

      {personalModels.value !== null && (
        <PersonalModelsModal
          services={personalServices}
          providerId={personalModels.value}
          onChangeService={(id) => personalModels.open(id)}
          onClose={personalModels.close}
          onAdvanced={(id) => editModel.open(id, "personalModels")}
        />
      )}

      <ModelFormModal
        open={editModel.target !== undefined}
        onClose={editModel.close}
        model={editModel.target ?? null}
        isPending={modelForm.isPending}
        onSubmit={modelForm.onSubmit}
        onDelete={canDeleteModels ? () => setDeletingModel(editModel.target ?? null) : undefined}
      />

      {/* Over the model form, which closes with it once the model is gone. */}
      <ConfirmModal
        open={deletingModel !== null}
        onClose={() => setDeletingModel(null)}
        title={t("models.deleteTitle")}
        confirmLabel={t("btn.delete", { ns: "common" })}
        description={deletingModel ? t("models.deleteConfirm", { label: deletingModel.label }) : ""}
        isPending={deleteModel.isPending}
        onConfirm={() => {
          if (!deletingModel) return;
          deleteModel.mutate(
            { params: { path: { id: deletingModel.id } } },
            {
              onSuccess: () => {
                setDeletingModel(null);
                editModel.close();
              },
            },
          );
        }}
      />

      {confirmDelete && (
        <DeleteKeyConfirm
          credential={confirmDelete}
          models={models ?? []}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
