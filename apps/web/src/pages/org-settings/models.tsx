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
 * models »; the instance's models are tested from its row, and the aliases the organization added
 * to it deleted there.
 *
 * The tab lives in the URL (`?tab=personal`), like the roles page's.
 */

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { usePermissions } from "../../hooks/use-permissions";
import {
  useDeleteModel,
  useModels,
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
import { useUrlModal, useUrlModalTarget } from "../../hooks/use-url-modal";
import { ModelFormModal } from "../../components/model-form-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { DeleteKeyConfirm } from "../../components/delete-key-confirm";
import { ConfirmModal } from "../../components/confirm-modal";
import { CollectionTabs } from "../../components/detail-tabs";
import { PreferencesModelsLink } from "../../components/preferences-models-link";
import { EmptyStateAction } from "../../components/page-states";
import { ProvidersTable } from "../../components/providers-table";
import { PersonalServicesTable } from "../../components/personal-services-table";
import { ProviderAddFlow } from "../../components/provider-add-flow";
import { PersonalModelsModal, ProviderModelsModal } from "../../components/model-choice-dialog";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PersonalCredentialsSetting } from "../../components/settings/personal-credentials-setting";
import { SettingsGroup } from "../../components/settings/setting-row";
import type { MenuAction } from "../../lib/menu-action";
import { TextSkeleton } from "../../components/loading-skeletons";
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
  const { data: credentials, isLoading: pkLoading, error: pkError } = useModelProviderCredentials();
  // A row is a key and its models: either read failing leaves the table wrong, so both surface.
  const tableError = modelsError ?? pkError;
  const { data: registry } = useProvidersRegistry();
  const { data: orgSettings, isLoading: settingsLoading } = useOrgSettings();

  const [addingProvider, setAddingProvider] = useState(false);
  const editKey = useUrlModalTarget("editCredential", credentials);
  const chooseModels = useUrlModalTarget("models", credentials);
  const personalModels = useUrlModal("personalModels");
  // The form edits what a list offers: never a model the instance ships.
  const [editModelId, setEditModelId] = useState<string | null>(null);
  const editTarget = useMemo(
    () => models?.find((m) => m.id === editModelId && !isSystemModel(m)),
    [models, editModelId],
  );

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

  const addCredential: MenuAction = {
    id: "create-credential",
    icon: Plus,
    label: t("credentials.add"),
    onSelect: () => setAddingProvider(true),
    hidden: !canWriteCredentials,
  };
  // The deed of the tab in view; a member who may write nothing has no menu.
  const allowPersonalModels: MenuAction = {
    id: "open-personal-service",
    icon: Plus,
    label: t("providers.allowPersonalModels"),
    onSelect: () => nextService && personalModels.open(nextService),
    hidden: !canWriteModels || !nextService,
  };

  const emptyOrg = {
    message: t("providers.empty"),
    hint: canWriteCredentials ? undefined : t("providers.emptyAskAdmin"),
    action: <EmptyStateAction action={addCredential} />,
  };

  return (
    <>
      <SettingsPageActions actions={[tab === "org" ? addCredential : allowPersonalModels]} />

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
            label={t("providers.tabOrg")}
            rows={orgRows}
            isLoading={modelsLoading || (canReadCredentials && pkLoading)}
            error={tableError}
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
            onDeleteModel={canDeleteModels ? setDeletingModel : undefined}
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
          {settingsLoading ? (
            <TextSkeleton lines={4} />
          ) : (
            <>
              {personalOff && (
                <p className="text-muted-foreground mb-3 text-sm">{t("providers.personalOff")}</p>
              )}
              <div inert={personalOff} className={cn("mb-6", personalOff && "opacity-50")}>
                <PersonalServicesTable
                  rows={serviceRows}
                  isLoading={modelsLoading || (canReadCredentials && pkLoading)}
                  error={tableError}
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
        </>
      )}

      {canWriteCredentials && addingProvider && (
        <ProviderAddFlow credentials={credentials ?? []} onClose={() => setAddingProvider(false)} />
      )}

      {editKey.target && (
        <CredentialFormModal
          key={editKey.target.id}
          onClose={editKey.close}
          credential={editKey.target}
          isPending={updateCredential.isPending}
          onSubmit={(data) => {
            // The PATCH body only accepts mutable fields: the protocol and endpoint are pinned
            // by `providerId` at create time.
            updateCredential.mutate(
              {
                params: { path: { id: editKey.target!.id } },
                body: credentialUpdateBody(editKey.target!, data),
              },
              { onSuccess: editKey.close },
            );
          }}
        />
      )}

      {chooseModels.target && (
        <ProviderModelsModal
          credential={chooseModels.target}
          onClose={chooseModels.close}
          // The model form replaces the list: two never stack.
          onAdvanced={(id) => {
            chooseModels.close();
            setEditModelId(id);
          }}
        />
      )}

      {personalModels.value !== null && (
        <PersonalModelsModal
          services={personalServices}
          providerId={personalModels.value}
          onChangeService={(id) => personalModels.open(id)}
          onClose={personalModels.close}
          onAdvanced={(id) => {
            personalModels.close();
            setEditModelId(id);
          }}
        />
      )}

      {editTarget && (
        <ModelFormModal
          onClose={() => setEditModelId(null)}
          model={editTarget}
          onDelete={canDeleteModels ? () => setDeletingModel(editTarget) : undefined}
        />
      )}

      {/* Over the model form (or the instance's row), which closes with it once the model is gone. */}
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
                setEditModelId(null);
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
