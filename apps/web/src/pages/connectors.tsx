import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "../hooks/use-org";
import { useServices } from "../hooks/use-services";
import { useCurrentProfileId, profileIdParam } from "../hooks/use-current-profile";
import {
  useConnect,
  useDisconnect,
  useConnectApiKey,
  useConnectCredentials,
  useCreateProvider,
  useUpdateProvider,
  useDeleteProvider,
} from "../hooks/use-mutations";
import { useProviders } from "../hooks/use-providers";
import { ApiKeyModal } from "../components/api-key-modal";
import { CustomCredentialsModal } from "../components/custom-credentials-modal";
import { ProfileSelector } from "../components/profile-selector";
import { ProviderCard } from "../components/provider-card";
import { ProviderFormModal } from "../components/provider-form-modal";
import { ProviderTemplatePicker } from "../components/provider-template-picker";
import { ProviderTemplateForm } from "../components/provider-template-form";
import { LoadingState, ErrorState } from "../components/page-states";
import type { JSONSchemaObject, ProviderConfig, ProviderTemplate } from "@appstrate/shared-types";

export function ConnectorsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg, isOrgAdmin } = useOrg();
  const profileId = useCurrentProfileId();
  const pParam = profileIdParam(profileId);
  const { data: integrations, isLoading: integrationsLoading, error } = useServices();
  const { data: providers, isLoading: providersLoading } = useProviders();
  const connectMutation = useConnect();
  const disconnectMutation = useDisconnect();
  const apiKeyMutation = useConnectApiKey();
  const credentialsMutation = useConnectCredentials();
  const createProviderMutation = useCreateProvider();
  const updateProviderMutation = useUpdateProvider();
  const deleteProviderMutation = useDeleteProvider();

  // Connection modals
  const [apiKeyProvider, setApiKeyProvider] = useState<{
    uniqueKey: string;
    displayName: string;
  } | null>(null);

  const [credProvider, setCredProvider] = useState<{
    uniqueKey: string;
    displayName: string;
    schema: JSONSchemaObject;
  } | null>(null);

  // Provider CRUD modals
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editProvider, setEditProvider] = useState<ProviderConfig | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<{
    template: ProviderTemplate;
    callbackUrl: string;
  } | null>(null);

  const isCredentialAuth = (providerId?: string): boolean => {
    const pDef = providers?.find((p) => p.id === providerId);
    return !!pDef?.credentialSchema;
  };

  const resolveAuthMode = (svc: { uniqueKey: string; authMode?: string }): string | undefined => {
    if (svc.authMode) return svc.authMode;
    const pDef = providers?.find((p) => p.id === svc.uniqueKey);
    return pDef?.authMode === "api_key"
      ? "API_KEY"
      : pDef?.authMode === "oauth2"
        ? "OAUTH2"
        : undefined;
  };

  const handleConnect = (svc: { uniqueKey: string; displayName: string; authMode?: string }) => {
    const authMode = resolveAuthMode(svc);
    if (authMode === "API_KEY") {
      setApiKeyProvider({ uniqueKey: svc.uniqueKey, displayName: svc.displayName });
    } else if (isCredentialAuth(svc.uniqueKey)) {
      const pDef = providers?.find((p) => p.id === svc.uniqueKey);
      const schema = (pDef?.credentialSchema as unknown as JSONSchemaObject) ?? {
        type: "object",
        properties: { url: { type: "string", description: "Proxy URL" } },
        required: ["url"],
      };
      setCredProvider({ uniqueKey: svc.uniqueKey, displayName: svc.displayName, schema });
    } else {
      connectMutation.mutate({ provider: svc.uniqueKey, ...pParam });
    }
  };

  const handleDisconnect = (provider: string, connectionId?: string) => {
    disconnectMutation.mutate({
      provider,
      ...(connectionId ? { connectionId } : pParam),
    });
  };

  const handleDeleteProvider = (p: ProviderConfig) => {
    if (!confirm(t("providers.deleteConfirm", { name: p.displayName }))) return;
    deleteProviderMutation.mutate(p.id);
  };

  const mergedItems = useMemo(() => {
    if (!providers) return [];
    const integrationMap = new Map((integrations ?? []).map((svc) => [svc.uniqueKey, svc]));
    return providers.map((p) => ({
      provider: p,
      integration: integrationMap.get(p.id),
    }));
  }, [providers, integrations]);

  const isLoading = providersLoading || integrationsLoading;

  return (
    <>
      <div className="header-row">
        <h2>{t("connectors.pageTitle", { orgName: currentOrg?.name })}</h2>
        <ProfileSelector />
      </div>

      <div className="service-card service-card-spaced">
        <div className="connectors-intro">
          <p className="service-provider">
            {isOrgAdmin
              ? t("connectors.adminDescription", { orgName: currentOrg?.name })
              : t("connectors.memberDescription", { orgName: currentOrg?.name })}
          </p>
        </div>
      </div>

      {isOrgAdmin && (
        <div className="tab-toolbar">
          <button className="primary" onClick={() => setTemplatePickerOpen(true)}>
            {t("providers.addProvider")}
          </button>
        </div>
      )}

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error.message} />
      ) : mergedItems.length === 0 ? (
        <div className="empty-state">
          <p>{t("connectors.noProviders")}</p>
          <p className="empty-hint">
            {isOrgAdmin
              ? t("connectors.noProvidersAdminHint")
              : t("connectors.noProvidersMemberHint")}
          </p>
        </div>
      ) : (
        <div className="services-grid">
          {mergedItems.map(({ provider, integration }) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              integration={integration}
              isAdmin={isOrgAdmin}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onEdit={(p) => {
                setEditProvider(p);
                setProviderModalOpen(true);
              }}
              onDelete={handleDeleteProvider}
              connectPending={
                connectMutation.isPending ||
                apiKeyMutation.isPending ||
                credentialsMutation.isPending
              }
              disconnectPending={disconnectMutation.isPending}
            />
          ))}
        </div>
      )}

      {/* Connection modals */}
      <ApiKeyModal
        open={!!apiKeyProvider}
        onClose={() => setApiKeyProvider(null)}
        providerName={apiKeyProvider?.displayName ?? ""}
        isPending={apiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          if (apiKeyProvider) {
            apiKeyMutation.mutate(
              { provider: apiKeyProvider.uniqueKey, apiKey, ...pParam },
              { onSuccess: () => setApiKeyProvider(null) },
            );
          }
        }}
      />

      {credProvider && (
        <CustomCredentialsModal
          open
          onClose={() => setCredProvider(null)}
          schema={credProvider.schema}
          serviceId={credProvider.uniqueKey}
          serviceName={credProvider.displayName}
          isPending={credentialsMutation.isPending}
          onSubmit={(credentials) => {
            credentialsMutation.mutate(
              { provider: credProvider.uniqueKey, credentials, ...pParam },
              { onSuccess: () => setCredProvider(null) },
            );
          }}
        />
      )}

      {/* Provider CRUD modals (admin only) */}
      <ProviderTemplatePicker
        open={templatePickerOpen}
        onClose={() => setTemplatePickerOpen(false)}
        onSelectTemplate={(template, callbackUrl) => {
          setTemplatePickerOpen(false);
          setSelectedTemplate({ template, callbackUrl });
        }}
        onSelectCustom={() => {
          setTemplatePickerOpen(false);
          setEditProvider(null);
          setProviderModalOpen(true);
        }}
      />

      {selectedTemplate && (
        <ProviderTemplateForm
          open={!!selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
          template={selectedTemplate.template}
          callbackUrl={selectedTemplate.callbackUrl}
        />
      )}

      <ProviderFormModal
        open={providerModalOpen}
        onClose={() => setProviderModalOpen(false)}
        provider={editProvider}
        isPending={createProviderMutation.isPending || updateProviderMutation.isPending}
        onSubmit={(data) => {
          if (editProvider) {
            updateProviderMutation.mutate(
              { id: editProvider.id, data },
              { onSuccess: () => setProviderModalOpen(false) },
            );
          } else {
            createProviderMutation.mutate(data, { onSuccess: () => setProviderModalOpen(false) });
          }
        }}
      />
    </>
  );
}
