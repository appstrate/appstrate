// SPDX-License-Identifier: Apache-2.0

/**
 * Preferences › Models: the organization's configurations that let members connect their own key
 * or subscription, one row each. A row says who serves the caller's calls to its models (their
 * own connection, the organization's, or nobody yet), offers « Utiliser ma clé », and holds the
 * menu of the caller's own connection. A configuration that refuses personal connections is
 * listed only where the caller still holds a connection: read-only, with its deletion.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { KeyRound, Pencil, RefreshCw, Trash2 } from "lucide-react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@appstrate/ui/components/item";
import { DeleteKeyConfirm } from "../../components/delete-key-confirm";
import {
  CredentialFormModal,
  type ConnectionFormTarget,
} from "../../components/credential-form-modal";
import { InlineEditableLabel } from "../../components/inline-editable-label";
import { ModelsPageSkeleton } from "../../components/loading-skeletons";
import { ConnectMenu } from "../../components/model-configs/connect-menu";
import { ConfigLogo, ConfigStateBadge } from "../../components/model-configs/model-config-row";
import {
  MODEL_ROW_ACTIONS,
  MODEL_ROW_ITEM,
  MODEL_ROW_MENUS,
} from "../../components/model-configs/row-layout";
import { EmptyState, ErrorState } from "../../components/page-states";
import { TableRowActions } from "../../components/table-row-actions";
import { useModelConfigs } from "../../hooks/use-model-configs";
import {
  useModelProviderCredentials,
  useProvidersRegistry,
  useUpdateModelProviderCredential,
  type ModelProviderCredentialInfo,
  type ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials";
import { usePermissions } from "../../hooks/use-permissions";
import {
  connectChoices,
  connectionLabelBody,
  personalServing,
  preferencesConfigs,
  type ConnectChoice,
  type ModelConfigInfo,
} from "../../lib/model-configs";
import { ownPersonalCredentials } from "../../lib/personal-model-credentials";
import { authStore } from "../../stores/auth-store";

export function PreferencesModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const userId = useStore(authStore, (s) => s.user?.id);
  const canConnect = can("model-provider-credentials:connect");

  const configsQuery = useModelConfigs();
  const credentialsQuery = useModelProviderCredentials();
  const registryQuery = useProvidersRegistry();
  const registry = registryQuery.data;
  const updateCredential = useUpdateModelProviderCredential();

  const [connecting, setConnecting] = useState<ConnectionFormTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ModelProviderCredentialInfo | null>(null);

  const own = ownPersonalCredentials(credentialsQuery.data ?? [], userId);
  const configs = configsQuery.data && preferencesConfigs(configsQuery.data, own);
  const error = configsQuery.error ?? credentialsQuery.error ?? registryQuery.error;
  // A row drawn before the caller's connections and the registry would offer « Utiliser ma clé »
  // to someone who already has one.
  const loading = !configs || credentialsQuery.isLoading || registryQuery.isLoading;

  return (
    <>
      {/* The skeleton carries the intro line itself: the page and its fallback stay one shape. */}
      {(!loading || error) && (
        <p className="text-muted-foreground mb-4 text-sm">{t("modelConfigs.preferences.intro")}</p>
      )}

      {error ? (
        <ErrorState error={error} />
      ) : !configs || loading ? (
        <ModelsPageSkeleton withDefault={false} />
      ) : configs.length === 0 ? (
        <EmptyState icon={KeyRound} message={t("modelConfigs.preferences.empty")} />
      ) : (
        <div className="flex flex-col gap-2">
          {configs.map((config) => (
            <PersonalConfigRow
              key={config.id}
              config={config}
              provider={registry?.find((p) => p.providerId === config.provider_id)}
              own={own}
              choices={connectChoices(
                config,
                registry ?? [],
                { org: false, personal: canConnect },
                own,
              )}
              onConnect={(choice) =>
                setConnecting({
                  kind: "create",
                  config,
                  provider: choice.provider,
                  ownerType: "user",
                })
              }
              onRename={async (credential, label) => {
                // A refusal is toasted by the mutation cache; the rejection keeps the label typed.
                await updateCredential.mutateAsync({
                  params: { path: { id: credential.id } },
                  body: connectionLabelBody(label),
                });
              }}
              onReplace={(credential) => setConnecting({ kind: "edit", credential })}
              onDelete={setConfirmDelete}
            />
          ))}
        </div>
      )}

      {connecting && (
        <CredentialFormModal
          key={connecting.kind === "edit" ? connecting.credential.id : connecting.config.id}
          target={connecting}
          onClose={() => setConnecting(null)}
        />
      )}

      {confirmDelete && (
        <DeleteKeyConfirm credential={confirmDelete} onClose={() => setConfirmDelete(null)} />
      )}
    </>
  );
}

function PersonalConfigRow({
  config,
  provider,
  own,
  choices,
  onConnect,
  onRename,
  onReplace,
  onDelete,
}: {
  config: ModelConfigInfo;
  provider: ProviderRegistryEntry | undefined;
  own: readonly ModelProviderCredentialInfo[];
  choices: readonly ConnectChoice[];
  onConnect: (choice: ConnectChoice) => void;
  onRename: (credential: ModelProviderCredentialInfo, label: string) => Promise<void>;
  onReplace: (credential: ModelProviderCredentialInfo) => void;
  onDelete: (credential: ModelProviderCredentialInfo) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [renaming, setRenaming] = useState(false);
  const serving = personalServing(config, own);
  const mine = serving.by === "mine" ? serving.connection : null;
  const allowed = new Set(mine?.allowed_actions ?? []);
  const subscription = mine?.authMode === "oauth2";
  // The organization switched personal connections off after the caller connected: it serves
  // nothing now, and only its deletion is left.
  const refused = !config.personal_connections_allowed;

  const description = refused
    ? t("modelConfigs.preferences.personalDisabled")
    : serving.by === "mine"
      ? t("modelConfigs.preferences.servedByMine", {
          account: serving.connection.oauth_email ?? serving.connection.label,
        })
      : serving.by === "org"
        ? t("modelConfigs.preferences.servedByOrg")
        : t("modelConfigs.preferences.servedByNone");

  return (
    // The container the row's layout answers to: its own width, not the screen's.
    <div className="@container/row" data-row>
      <Item variant="outline" size="sm" className={MODEL_ROW_ITEM}>
        <ConfigLogo provider={provider} />
        <ItemContent className="min-w-0">
          <ItemTitle className="max-w-full min-w-0">
            <span className="truncate" title={config.label}>
              {config.label}
            </span>
          </ItemTitle>
          <ItemDescription>
            {mine && renaming && !refused ? (
              <InlineEditableLabel
                value={mine.label}
                editable={allowed.has("edit")}
                editing={renaming}
                onEditingChange={setRenaming}
                onSave={(label) => onRename(mine, label)}
              />
            ) : (
              description
            )}
          </ItemDescription>
        </ItemContent>
        <ItemActions className={MODEL_ROW_ACTIONS}>
          {!refused && <ConfigStateBadge state={serving.state} />}
          {!mine && (
            <ConnectMenu
              choices={choices}
              label={t("modelConfigs.preferences.useMine")}
              onPick={onConnect}
            />
          )}
          {mine && (
            <div className={MODEL_ROW_MENUS}>
              <TableRowActions
                menuLabel={t("modelConfigs.connections.menu", { label: mine.label })}
                renaming={renaming}
                actions={[
                  {
                    id: "rename",
                    icon: Pencil,
                    label: t("btn.rename", { ns: "common" }),
                    onSelect: () => setRenaming(true),
                    hidden: refused || !allowed.has("edit"),
                  },
                  {
                    id: "replace",
                    icon: subscription ? RefreshCw : KeyRound,
                    label: subscription
                      ? t("modelConfigs.connect.reconnect")
                      : t("credentials.edit"),
                    onSelect: () => onReplace(mine),
                    hidden:
                      refused || (subscription ? !allowed.has("reconnect") : !allowed.has("edit")),
                  },
                  {
                    id: "delete",
                    icon: Trash2,
                    label: t("btn.delete", { ns: "common" }),
                    onSelect: () => onDelete(mine),
                    destructive: true,
                    hidden: !allowed.has("delete"),
                  },
                ]}
              />
            </div>
          )}
        </ItemActions>
      </Item>
    </div>
  );
}
