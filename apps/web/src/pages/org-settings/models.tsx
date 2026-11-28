// SPDX-License-Identifier: Apache-2.0

/**
 * Settings › Models: the organization's default model, then its model configurations, then the
 * instance's own models.
 *
 * A **configuration** is a service the organization set up (its label, a gateway's endpoint, its
 * models, whether members may connect their own); its **connections** (the organization's, the
 * members') serve its models (`lib/model-configs.ts`). One row per configuration, collapsed to
 * its state and the repair it needs, open on its connections and models.
 *
 * A model's own deeds (test, delete, its finer settings) are in its form, opened from its chip or
 * from « Choisir les modèles ».
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Plus, Sparkles } from "lucide-react";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@appstrate/ui/components/item";
import { usePermissions } from "../../hooks/use-permissions";
import { useDeleteModel, useModels, type OrgModelInfo } from "../../hooks/use-models";
import {
  useDeleteModelConfig,
  useModelConfigs,
  useUpdateModelConfig,
} from "../../hooks/use-model-configs";
import {
  useModelProviderCredentials,
  useProvidersRegistry,
  useUpdateModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "../../hooks/use-model-provider-credentials";
import {
  CredentialFormModal,
  type ConnectionFormTarget,
} from "../../components/credential-form-modal";
import { ConfirmModal } from "../../components/confirm-modal";
import { DeleteKeyConfirm } from "../../components/delete-key-confirm";
import { ModelChoiceDialog } from "../../components/model-choice-dialog";
import { ModelFormModal } from "../../components/model-form-modal";
import { EmptyState, EmptyStateAction, ErrorState } from "../../components/page-states";
import { ModelsPageSkeleton } from "../../components/loading-skeletons";
import { ConfigStateBadge, ModelConfigRow } from "../../components/model-configs/model-config-row";
import { DefaultModelSetting } from "../../components/model-configs/default-model-setting";
import { ModelConfigEndpointDialog } from "../../components/model-configs/model-config-dialogs";
import { AddConfigFlow } from "../../components/model-configs/add-config-flow";
import { ModelChips } from "../../components/model-configs/model-chips";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { SettingsGroup } from "../../components/settings/setting-row";
import { SettingsHeading } from "../../components/settings/settings-heading";
import type { MenuAction } from "../../lib/menu-action";
import {
  configUpdateBody,
  connectChoices,
  connectionsOfConfig,
  isSystemModel,
  modelsOfConfig,
  systemModels,
} from "../../lib/model-configs";

export function OrgSettingsModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const canWriteModels = can("models:write");
  const canDeleteModels = can("models:delete");
  const canWriteCredentials = can("model-provider-credentials:write");
  const canConnect = can("model-provider-credentials:connect");
  // `connect` alone lists only the caller's own: the organization's are counted under `read`.
  const canReadCredentials = can("model-provider-credentials:read");

  const modelsQuery = useModels();
  const configsQuery = useModelConfigs();
  const credentialsQuery = useModelProviderCredentials();
  const { data: registry } = useProvidersRegistry();
  const models = modelsQuery.data;
  const configs = configsQuery.data;
  const credentials = credentialsQuery.data ?? [];
  const countsOrgConnections = canReadCredentials && credentialsQuery.data !== undefined;

  const updateConfig = useUpdateModelConfig();
  const deleteConfig = useDeleteModelConfig();
  const updateCredential = useUpdateModelProviderCredential();
  const deleteModel = useDeleteModel();

  const [adding, setAdding] = useState(false);
  /** The configuration just made or asked for: its row opens. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [choosingId, setChoosingId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<ConnectionFormTarget | null>(null);
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [deletingConfigId, setDeletingConfigId] = useState<string | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<ModelProviderCredentialInfo | null>(
    null,
  );
  // The form edits what a configuration offers: never a model the instance ships.
  const [editModelId, setEditModelId] = useState<string | null>(null);
  const [deletingModel, setDeletingModel] = useState<OrgModelInfo | null>(null);

  const configOf = (id: string | null) => configs?.find((c) => c.id === id);
  const choosingConfig = configOf(choosingId);
  const endpointConfig = configOf(endpointId);
  const deletingConfig = configOf(deletingConfigId);
  const editTarget = useMemo(
    () => models?.find((m) => m.id === editModelId && !isSystemModel(m)),
    [models, editModelId],
  );

  const addConfig: MenuAction = {
    id: "add-model-config",
    icon: Plus,
    label: t("modelConfigs.add.action"),
    onSelect: () => setAdding(true),
    hidden: !canWriteModels,
  };

  const error = modelsQuery.error ?? configsQuery.error;
  const system = systemModels(models ?? []);

  return (
    <>
      <SettingsPageActions actions={[addConfig]} />

      {error ? (
        <ErrorState error={error} />
      ) : !models || !configs ? (
        <ModelsPageSkeleton />
      ) : (
        <>
          <SettingsGroup>
            <DefaultModelSetting
              models={models}
              configs={configs}
              registry={registry ?? []}
              canWrite={canWriteModels}
            />
          </SettingsGroup>

          <SettingsHeading level="group" title={t("modelConfigs.title")} />
          <div className="flex flex-col gap-2">
            {configs.length === 0 && (
              <EmptyState
                icon={Boxes}
                message={t("modelConfigs.empty")}
                hint={canWriteModels ? undefined : t("modelConfigs.emptyAskAdmin")}
              >
                <EmptyStateAction action={addConfig} />
              </EmptyState>
            )}
            {configs.map((config) => {
              const connections = connectionsOfConfig(credentials, config.id);
              return (
                <ModelConfigRow
                  // A configuration asked for opens: a fresh row is mounted open.
                  key={config.id === focusedId ? `${config.id}:focused` : config.id}
                  config={config}
                  provider={registry?.find((p) => p.providerId === config.provider_id)}
                  models={modelsOfConfig(models, config.id)}
                  connections={connections}
                  orgConnectionCount={countsOrgConnections ? connections.org.length : null}
                  can={{ writeModels: canWriteModels, deleteModels: canDeleteModels }}
                  choices={connectChoices(config, registry ?? [], {
                    org: canWriteCredentials,
                    personal: canConnect,
                  })}
                  defaultOpen={config.id === focusedId}
                  onConnect={(choice) =>
                    setConnecting({
                      kind: "create",
                      config,
                      provider: choice.provider,
                      ownerType: choice.owner,
                    })
                  }
                  onChooseModels={() => setChoosingId(config.id)}
                  onOpenModel={(model) => setEditModelId(model.id)}
                  onRename={async (label) => {
                    await updateConfig.mutateAsync({
                      params: { path: { id: config.id } },
                      body: configUpdateBody({ label }),
                    });
                  }}
                  onEditEndpoint={() => setEndpointId(config.id)}
                  onDelete={() => setDeletingConfigId(config.id)}
                  onTogglePersonal={(allowed) =>
                    updateConfig.mutate({
                      params: { path: { id: config.id } },
                      body: configUpdateBody({ personalConnectionsAllowed: allowed }),
                    })
                  }
                  connectionDeeds={{
                    onRename: async (credential, label) => {
                      // A refusal is toasted by the mutation cache; the rejection keeps the label typed.
                      await updateCredential.mutateAsync({
                        params: { path: { id: credential.id } },
                        body: { label },
                      });
                    },
                    onReplace: (credential) => setConnecting({ kind: "edit", credential }),
                    onDelete: setDeletingConnection,
                  }}
                />
              );
            })}
            {system.length > 0 && <SystemModelsRow models={system} />}
          </div>
        </>
      )}

      {adding && <AddConfigFlow onClose={() => setAdding(false)} onFocus={setFocusedId} />}

      {choosingConfig && (
        <ModelChoiceDialog
          config={choosingConfig}
          onClose={() => setChoosingId(null)}
          // The model form replaces the list: two never stack.
          onAdvanced={(id) => {
            setChoosingId(null);
            setEditModelId(id);
          }}
        />
      )}

      {connecting && (
        <CredentialFormModal
          key={connecting.kind === "edit" ? connecting.credential.id : connecting.config.id}
          target={connecting}
          onClose={() => setConnecting(null)}
        />
      )}

      {endpointConfig && registry && (
        <ModelConfigEndpointDialog
          config={endpointConfig}
          registry={registry}
          onClose={() => setEndpointId(null)}
        />
      )}

      <ConfirmModal
        open={!!deletingConfig}
        onClose={() => setDeletingConfigId(null)}
        title={t("modelConfigs.delete.title")}
        confirmLabel={t("btn.delete", { ns: "common" })}
        description={
          deletingConfig ? t("modelConfigs.delete.confirm", { label: deletingConfig.label }) : ""
        }
        isPending={deleteConfig.isPending}
        onConfirm={() => {
          if (!deletingConfig) return;
          deleteConfig.mutate(
            { params: { path: { id: deletingConfig.id } } },
            { onSuccess: () => setDeletingConfigId(null) },
          );
        }}
      />

      {deletingConnection && (
        <DeleteKeyConfirm
          credential={deletingConnection}
          onClose={() => setDeletingConnection(null)}
        />
      )}

      {editTarget && (
        <ModelFormModal
          onClose={() => setEditModelId(null)}
          model={editTarget}
          onDelete={canDeleteModels ? () => setDeletingModel(editTarget) : undefined}
        />
      )}

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
                setEditModelId(null);
              },
            },
          );
        }}
      />
    </>
  );
}

/** The instance's own models: the last row, nothing to connect nor to configure. */
function SystemModelsRow({ models }: { models: readonly OrgModelInfo[] }) {
  const { t } = useTranslation("settings");
  return (
    <Item variant="outline" size="sm" className="flex-nowrap items-start">
      <ItemMedia variant="icon">
        <Sparkles />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-2">
        <ItemTitle>{t("modelConfigs.system.label")}</ItemTitle>
        <ItemDescription>{t("modelConfigs.system.description")}</ItemDescription>
        <ModelChips models={models.filter((m) => m.enabled || m.is_default)} />
      </ItemContent>
      <ConfigStateBadge state="system" />
    </Item>
  );
}
