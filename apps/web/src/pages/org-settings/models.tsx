// SPDX-License-Identifier: Apache-2.0

/**
 * Settings › Models: the organization's providers, one table. A connected provider makes its
 * models available (`lib/model-providers.ts`): an organization key serves the models bound to
 * it, a personal key or subscription serves the models left to personal keys, the instance
 * serves its own. Below it, the setting that lets people use their own.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { usePermissions } from "../../hooks/use-permissions";
import {
  useModels,
  useModelFormHandler,
  useSetDefaultModel,
  type OrgModelInfo,
} from "../../hooks/use-models";
import {
  useModelProviderCredentials,
  useDeleteModelProviderCredential,
  useProvidersRegistry,
  useUpdateModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../../hooks/use-model-provider-credentials";
import { useOrgSettings } from "../../hooks/use-org-settings";
import { useListParams } from "../../lib/list-params";
import { NoAccessState } from "../../components/route-gate";
import { useModalParam, useModalTarget } from "../../hooks/use-modal-param";
import { ModelFormModal } from "../../components/model-form-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { PreferencesModelsLink } from "../../components/preferences-models-link";
import { EmptyStateAction } from "../../components/page-states";
import { ProvidersTable } from "../../components/providers-table";
import { ProviderAddFlow } from "../../components/provider-add-flow";
import { PersonalModelsModal, ProviderModelsModal } from "../../components/model-choice-dialog";
import { ListToolbar, type FilterSpec } from "../../components/list-toolbar";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { PersonalCredentialsSetting } from "../../components/settings/personal-credentials-setting";
import { SettingRow, SettingsGroup } from "../../components/settings/setting-row";
import { PageActionsMenu } from "../../components/page-actions-menu";
import { credentialUpdateBody } from "../../lib/personal-model-credentials";
import {
  filterProviderRows,
  personalModelServices,
  personalModelSummary,
  providerRows,
  type ProviderKind,
} from "../../lib/model-providers";
import { authStore } from "../../stores/auth-store";

const KINDS: readonly ProviderKind[] = ["org-key", "personal-key", "subscription", "system"];

/** « Anthropic : Claude Fable 5.1 · Mistral : aucun » */
function personalSummary(summary: ReturnType<typeof personalModelSummary>, none: string): string {
  return summary
    .map(
      ({ service, models }) =>
        `${service.displayName} : ${models.length > 0 ? models.map((m) => m.label).join(", ") : none}`,
    )
    .join(" · ");
}

export function OrgSettingsModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
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

  const [confirmDelete, setConfirmDelete] = useState<ModelProviderCredentialInfo | null>(null);
  const deleteCredential = useDeleteModelProviderCredential();
  const updateCredential = useUpdateModelProviderCredential();
  const setDefault = useSetDefaultModel();
  const modelForm = useModelFormHandler({
    editModel: editModel.target ?? null,
    onSuccess: editModel.close,
  });

  const allRows = useMemo(
    () => providerRows(models ?? [], credentials ?? [], registry ?? [], userId),
    [models, credentials, registry, userId],
  );

  const list = useListParams(["type", "service", "owner"]);
  const serviceOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of allRows) {
      for (const id of row.serviceIds) {
        seen.set(id, registry?.find((p) => p.providerId === id)?.displayName ?? id);
      }
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [allRows, registry]);
  const ownerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of allRows) {
      if (seen.has(row.owner)) continue;
      const mine = row.owner === `user:${userId}`;
      seen.set(
        row.owner,
        row.owner === "org"
          ? t("providers.owner.org")
          : row.owner === "instance"
            ? t("providers.owner.instance")
            : `${row.ownerName ?? "—"}${mine ? ` (${t("credentials.you")})` : ""}`,
      );
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [allRows, userId, t]);

  const types = list.values("type", KINDS);
  const services = list.values(
    "service",
    serviceOptions.map((o) => o.value),
  );
  const owners = list.values(
    "owner",
    ownerOptions.map((o) => o.value),
  );
  const rows = filterProviderRows(allRows, { types, services, owners });
  const filtered = types.length + services.length + owners.length > 0;

  const filters: FilterSpec[] = [
    {
      id: "type",
      label: t("providers.col.type"),
      values: types,
      options: KINDS.map((kind) => ({
        value: kind,
        label: t(
          {
            "org-key": "providers.type.orgKey",
            "personal-key": "providers.type.personalKey",
            subscription: "providers.type.subscription",
            system: "providers.type.system",
          }[kind],
        ),
      })),
      onChange: list.setValues("type"),
    },
    {
      id: "service",
      label: t("providers.col.service"),
      values: services,
      options: serviceOptions,
      onChange: list.setValues("service"),
    },
    {
      id: "owner",
      label: t("providers.col.owner"),
      values: owners,
      options: ownerOptions,
      onChange: list.setValues("owner"),
    },
  ];

  // `org_models.credential_id` is ON DELETE RESTRICT (409 `credential_in_use`): the dialog
  // says so before asking the server, and points to where the models are removed.
  const modelsOnDeleted = confirmDelete
    ? (models ?? []).filter((m) => m.credentialId === confirmDelete.id).length
    : 0;

  const summary = personalModelSummary(models ?? [], allRows, registry ?? []);
  const personalServices = personalModelServices(registry ?? []);
  const personalAllowed = orgSettings?.personal_model_credentials === true;

  if (!can("models:read")) return <NoAccessState />;

  const clearFilters = () => list.reset();
  const empty = filtered
    ? {
        message: t("common:toolbar.noResults"),
        action: <EmptyStateAction label={t("common:toolbar.clearAll")} onClick={clearFilters} />,
      }
    : {
        message: t("providers.empty"),
        hint: canWriteCredentials ? undefined : t("providers.emptyAskAdmin"),
        action: canWriteCredentials ? (
          <EmptyStateAction label={t("credentials.add")} onClick={() => addProvider.open()} />
        ) : undefined,
      };

  return (
    <>
      {canWriteCredentials && (
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

      <ListToolbar filters={filters} onReset={clearFilters} />
      <div className="mb-8">
        <ProvidersTable
          rows={rows}
          userId={userId}
          isLoading={modelsLoading || (canReadCredentials && pkLoading)}
          error={modelsError}
          empty={empty}
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

      {(can("org:settings") || canWriteModels) && (
        <SettingsGroup title={t("providers.personalTitle")}>
          <PersonalCredentialsSetting />
          {personalAllowed && summary.length > 0 && (
            <SettingRow
              variant="action"
              label={t("providers.personalModels")}
              description={personalSummary(summary, t("providers.noneLower"))}
            >
              {canWriteModels && (
                <Button variant="outline" size="sm" onClick={() => personalModels.open()}>
                  {t("providers.edit")}
                </Button>
              )}
            </SettingRow>
          )}
        </SettingsGroup>
      )}

      {canConnect && personalAllowed && (
        <p className="text-muted-foreground text-sm">
          {t("providers.personalFooter")}{" "}
          <PreferencesModelsLink>{t("providers.personalFooterLink")}</PreferencesModelsLink>
        </p>
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

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t("credentials.deleteTitle")}
        confirmLabel={t("btn.delete", { ns: "common" })}
        description={
          confirmDelete
            ? modelsOnDeleted > 0
              ? t("credentials.deleteInUse", {
                  label: confirmDelete.label,
                  count: modelsOnDeleted,
                })
              : t("credentials.deleteConfirm", { label: confirmDelete.label })
            : ""
        }
        confirmDisabled={modelsOnDeleted > 0}
        isPending={deleteCredential.isPending}
        onConfirm={() => {
          if (!confirmDelete) return;
          deleteCredential.mutate(
            { params: { path: { id: confirmDelete.id } } },
            { onSuccess: () => setConfirmDelete(null) },
          );
        }}
      />
    </>
  );
}
