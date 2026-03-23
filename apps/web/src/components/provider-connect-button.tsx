import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  useConnect,
  useConnectApiKey,
  useConnectCredentials,
  useDisconnect,
} from "../hooks/use-mutations";
import { useIntegrations } from "../hooks/use-integrations";
import { useCurrentProfileId, profileIdParam } from "../hooks/use-current-profile";
import { useConnectionProfiles } from "../hooks/use-connection-profiles";
import { connectedLabelWithProfile } from "../lib/provider-status";
import { ApiKeyModal } from "./api-key-modal";
import { CustomCredentialsModal } from "./custom-credentials-modal";
import type { ProviderConfig, JSONSchemaObject } from "@appstrate/shared-types";

export function ProviderConnectButton({ provider }: { provider: ProviderConfig }) {
  const { t } = useTranslation(["settings", "flows"]);
  const profileId = useCurrentProfileId();
  const pParam = profileIdParam(profileId);
  const { data: profiles } = useConnectionProfiles();
  const { data: integrations } = useIntegrations();

  const connectMutation = useConnect();
  const connectApiKeyMutation = useConnectApiKey();
  const connectCredentialsMutation = useConnectCredentials();
  const disconnectMutation = useDisconnect();

  const [apiKeyProvider, setApiKeyProvider] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [customCredProvider, setCustomCredProvider] = useState<{
    id: string;
    name: string;
    schema: JSONSchemaObject;
  } | null>(null);

  const isPending =
    connectMutation.isPending ||
    connectApiKeyMutation.isPending ||
    connectCredentialsMutation.isPending ||
    disconnectMutation.isPending;

  const isConnected = integrations?.some(
    (i) => i.provider === provider.id && i.status === "connected",
  );

  const handleConnect = () => {
    if (provider.authMode === "api_key") {
      setApiKeyProvider({ id: provider.id, name: provider.displayName });
    } else if (provider.authMode === "custom" && provider.credentialSchema) {
      setCustomCredProvider({
        id: provider.id,
        name: provider.displayName,
        schema: provider.credentialSchema as unknown as JSONSchemaObject,
      });
    } else {
      connectMutation.mutate({ provider: provider.id, ...pParam });
    }
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate({ provider: provider.id, ...pParam });
  };

  return (
    <>
      {isConnected ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-emerald-500">
            {connectedLabelWithProfile(t("providers.connected"), profiles, profileId)}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={handleDisconnect}
            disabled={isPending}
          >
            {t("detail.disconnect", { ns: "flows" })}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={handleConnect}
          disabled={!provider.enabled || isPending}
          title={!provider.enabled ? t("providers.notConfigured") : undefined}
        >
          {t("detail.connect", { ns: "flows" })}
        </Button>
      )}
      <ApiKeyModal
        open={!!apiKeyProvider}
        onClose={() => setApiKeyProvider(null)}
        providerName={apiKeyProvider?.name ?? ""}
        isPending={connectApiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          if (!apiKeyProvider) return;
          connectApiKeyMutation.mutate(
            { provider: apiKeyProvider.id, apiKey, ...pParam },
            { onSuccess: () => setApiKeyProvider(null) },
          );
        }}
      />
      {customCredProvider && (
        <CustomCredentialsModal
          open
          onClose={() => setCustomCredProvider(null)}
          schema={customCredProvider.schema}
          providerId={customCredProvider.id}
          providerName={customCredProvider.name}
          isPending={connectCredentialsMutation.isPending}
          onSubmit={(credentials) => {
            connectCredentialsMutation.mutate(
              { provider: customCredProvider.id, credentials, ...pParam },
              { onSuccess: () => setCustomCredProvider(null) },
            );
          }}
        />
      )}
    </>
  );
}
