// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import {
  ApiKeyForm,
  SubscriptionPairing,
} from "../../components/personal-model-credential-dialogs";
import { ConfirmModal } from "../../components/confirm-modal";
import { PROVIDER_ICONS } from "../../components/icons";
import { InlineLabelEditor } from "../../components/inline-label-editor";
import { EmptyState, ErrorState, LoadingState } from "../../components/page-states";
import {
  useDeleteModelProviderCredential,
  useModelProviderCredentials,
  useProvidersRegistry,
  useUpdateModelProviderCredential,
  type ModelProviderCredentialInfo,
  type ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials";
import { useModels } from "../../hooks/use-models";
import { useAuth } from "../../hooks/use-auth";
import { usePermissions } from "../../hooks/use-permissions";
import { formatDateField } from "../../lib/format-date";
import { errorMessage } from "../../lib/mutation-error";
import {
  modelsPaidByCaller,
  ownPersonalCredentials,
  personalApiKeyProviders,
} from "../../lib/personal-model-credentials";
import { quickConnectProviders, resolveProviderEntry } from "../../lib/provider-registry-helpers";

// ─────────────────────────────────────────────
// Credential row
// ─────────────────────────────────────────────

function CredentialRow({
  credential,
  registry,
  editable,
  saving,
  onRename,
  onDelete,
}: {
  credential: ModelProviderCredentialInfo;
  registry: readonly ProviderRegistryEntry[];
  editable: boolean;
  saving: boolean;
  onRename: (label: string, onSuccess: () => void) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  // Inline lookup, as `react-hooks/static-components` requires (see credential-form-modal).
  const ProviderIcon = PROVIDER_ICONS[resolveProviderEntry(credential, registry)?.iconUrl ?? ""];
  const isOauth = credential.authMode === "oauth2";

  return (
    <div
      className="border-border bg-card flex items-start justify-between gap-4 rounded-md border p-3"
      data-testid={`model-credential-row-${credential.id}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {ProviderIcon && <ProviderIcon className="text-muted-foreground size-4 shrink-0" />}
          {editable ? (
            <InlineLabelEditor
              current={credential.label}
              saving={saving}
              onSave={onRename}
              editTitle={t("credentials.edit")}
              placeholder={t("modelCredentials.labelPlaceholder")}
              className="text-foreground text-sm font-medium"
              iconClassName="text-muted-foreground"
              inputClassName="w-44"
            />
          ) : (
            <span className="text-sm font-medium">{credential.label}</span>
          )}
          <Badge variant="secondary">
            {isOauth ? t("credentials.oauth.badgeOauth") : t("credentials.form.apiKey")}
          </Badge>
          {credential.needs_reconnection && (
            <Badge variant="destructive">
              {isOauth
                ? t("credentials.oauth.needsReconnection")
                : t("models.credentialUnavailable")}
            </Badge>
          )}
        </div>
        {isOauth && credential.oauth_email && (
          <span className="text-muted-foreground text-xs">
            {t("credentials.oauth.connectedAs", { email: credential.oauth_email })}
          </span>
        )}
        {credential.createdAt && (
          <span className="text-muted-foreground text-xs">
            {t("connections.connectedAtLabel")} {formatDateField(credential.createdAt)}
          </span>
        )}
      </div>
      {editable && (
        <Button
          variant="destructive"
          size="sm"
          className="shrink-0"
          onClick={onDelete}
          disabled={saving}
        >
          {t("credentials.delete")}
        </Button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────

export function PreferencesModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const canConnect = can("model-provider-credentials:connect");
  const credentialsQuery = useModelProviderCredentials();
  const registryQuery = useProvidersRegistry();
  const modelsQuery = useModels();
  const updateCredential = useUpdateModelProviderCredential();
  const deleteCredential = useDeleteModelProviderCredential();

  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ModelProviderCredentialInfo | null>(null);

  if (credentialsQuery.isLoading) return <LoadingState />;
  if (credentialsQuery.error) return <ErrorState error={credentialsQuery.error} />;

  const registry = registryQuery.data ?? [];
  const apiKeyProviders = personalApiKeyProviders(registry);
  const subscriptionProviders = quickConnectProviders(registry);
  const credentials = ownPersonalCredentials(credentialsQuery.data ?? [], user?.id);
  const paidByCaller = modelsPaidByCaller(modelsQuery.data ?? []);

  // A credential's add, rename or delete changes which models the caller pays for.
  const refreshModels = () => {
    void queryClient.invalidateQueries({ queryKey: ["get", "/api/models"] });
  };

  const addButtons = canConnect ? (
    <>
      {apiKeyProviders.length > 0 && (
        <Button onClick={() => setApiKeyOpen(true)}>{t("modelCredentials.add")}</Button>
      )}
      {subscriptionProviders.length > 0 && (
        <Button variant="outline" onClick={() => setSubscriptionOpen(true)}>
          {t("modelCredentials.connect")}
        </Button>
      )}
    </>
  ) : null;

  return (
    <>
      <p className="text-muted-foreground mb-4 text-sm">{t("modelCredentials.description")}</p>

      {credentials.length > 0 ? (
        <>
          {canConnect && (
            <div className="mb-4 flex flex-wrap items-center justify-end gap-2">{addButtons}</div>
          )}
          <div className="flex flex-col gap-3">
            {credentials.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                registry={registry}
                editable={canConnect}
                saving={updateCredential.isPending || deleteCredential.isPending}
                onRename={(label, onSuccess) =>
                  updateCredential.mutate(
                    { params: { path: { id: credential.id } }, body: { label } },
                    { onSuccess },
                  )
                }
                onDelete={() => setConfirmDelete(credential)}
              />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          message={t("modelCredentials.empty")}
          hint={t("modelCredentials.emptyHint")}
          icon={KeyRound}
          compact
        >
          {addButtons}
        </EmptyState>
      )}

      <div className="border-border bg-card mt-6 rounded-lg border p-5">
        <h3 className="text-sm font-medium">{t("modelCredentials.billedTitle")}</h3>
        {modelsQuery.error ? (
          <p className="text-destructive mt-2 text-xs">{errorMessage(modelsQuery.error)}</p>
        ) : paidByCaller.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1.5">
            {paidByCaller.map((m) => (
              <li key={m.id} className="text-sm">
                {m.label}
                {m.provider_name && (
                  <span className="text-muted-foreground text-xs"> · {m.provider_name}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground mt-2 text-sm">{t("modelCredentials.billedNone")}</p>
        )}
      </div>

      {apiKeyOpen && (
        <ApiKeyForm
          onClose={() => setApiKeyOpen(false)}
          providers={apiKeyProviders}
          onCreated={refreshModels}
        />
      )}
      {subscriptionOpen && (
        <SubscriptionPairing
          onClose={() => {
            setSubscriptionOpen(false);
            refreshModels();
          }}
          providers={subscriptionProviders}
        />
      )}

      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          confirmDelete ? t("modelCredentials.deleteConfirm", { label: confirmDelete.label }) : ""
        }
        isPending={deleteCredential.isPending}
        onConfirm={() => {
          if (!confirmDelete) return;
          deleteCredential.mutate(
            { params: { path: { id: confirmDelete.id } } },
            {
              onSuccess: () => {
                setConfirmDelete(null);
                refreshModels();
              },
            },
          );
        }}
      >
        <p className="text-muted-foreground text-sm">{t("modelCredentials.deleteImpact")}</p>
      </ConfirmModal>
    </>
  );
}
