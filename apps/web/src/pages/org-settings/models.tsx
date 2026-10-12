// SPDX-License-Identifier: Apache-2.0

/**
 * Settings › Models: the organization's providers, in two tabs. A connected provider makes its
 * models available (`lib/model-providers.ts`).
 *
 * - **Clés org**: the organization's keys, and the instance's own models. An organization key
 *   serves the models bound to it, the instance serves the ones it ships.
 * - **Clés perso**: the setting that lets people use a key or a subscription of their own, and
 *   one row per service open to them: its models, and who plugged a key in.
 *
 * The tab lives in the URL (`?tab=personal`), like the roles page's.
 */

import { useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Plus } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { cn } from "@appstrate/ui/cn";
import { usePermissions } from "../../hooks/use-permissions";
import {
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
import { DeleteOrgKeyConfirm } from "../../components/delete-org-key-confirm";
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
  personalModelServices,
  personalServiceRows,
  providerRows,
} from "../../lib/model-providers";
import { authStore } from "../../stores/auth-store";

type ModelsTab = "org" | "personal";

export function OrgSettingsModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const location = useLocation();
  const userId = useStore(authStore, (s) => s.user?.id);

  const canWriteModels = can("models:write");
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
  const editModel = useModalTarget("editModel", models);

  // The tab is a place: `?tab=personal` opens it, and the first one leaves the URL alone.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: ModelsTab = searchParams.get("tab") === "personal" ? "personal" : "org";
  const setTab = (next: ModelsTab) =>
    setSearchParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next === "org") out.delete("tab");
        else out.set("tab", next);
        return out;
      },
      { state: location.state },
    );

  const [confirmDelete, setConfirmDelete] = useState<ModelProviderCredentialInfo | null>(null);
  const updateCredential = useUpdateModelProviderCredential();
  const setDefault = useSetDefaultModel();
  const modelForm = useModelFormHandler({
    editModel: editModel.target ?? null,
    onSuccess: editModel.close,
  });

  const orgRows = useMemo(
    () =>
      providerRows(models ?? [], credentials ?? [], registry ?? [], userId).filter(
        (row) => row.kind === "org-key" || row.kind === "system",
      ),
    [models, credentials, registry, userId],
  );
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
            rows={orgRows}
            isLoading={modelsLoading || (canReadCredentials && pkLoading)}
            error={modelsError}
            empty={emptyOrg}
            canWriteModels={canWriteModels}
            onRename={async (pk, label) => {
              // A refusal is toasted by the mutation cache; the rejection keeps the label being typed.
              await updateCredential.mutateAsync({
                params: { path: { id: pk.id } },
                body: { label },
              });
            }}
            onChooseModels={(pk) => chooseModels.open(pk.id)}
            onChangeKey={(pk) => editKey.open(pk.id)}
            onReconnect={(pk) => editKey.open(pk.id)}
            onDelete={setConfirmDelete}
            onSetDefault={(m: OrgModelInfo) => setDefault.mutate({ body: { modelId: m.id } })}
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
        apiKeyOnly
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
        />
      )}

      <ModelFormModal
        open={editModel.target !== undefined}
        onClose={editModel.close}
        model={editModel.target ?? null}
        isPending={modelForm.isPending}
        onSubmit={modelForm.onSubmit}
      />

      {confirmDelete && (
        <DeleteOrgKeyConfirm
          credential={confirmDelete}
          models={models ?? []}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
