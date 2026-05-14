// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  useConnect,
  useConnectApiKey,
  useConnectCredentials,
  useDisconnect,
} from "../hooks/use-mutations";
import { useAvailableProviders } from "../hooks/use-available-providers";
import { ApiKeyModal } from "./api-key-modal";
import { CustomCredentialsModal } from "./custom-credentials-modal";
import type { ProviderConfig } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";

export function ProviderConnectButton({
  provider,
  connectionProfileId,
}: {
  provider: ProviderConfig;
  connectionProfileId?: string | null;
}) {
  const { t } = useTranslation(["settings", "agents"]);
  const { data: availableProviders } = useAvailableProviders(connectionProfileId);

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

  const isConnected = availableProviders?.some(
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
    } else if (provider.authMode === "password" || provider.authMode === "basic") {
      // ROPC + HTTP Basic both collect the same two fields. The
      // server-side handler dispatches on the provider's declared
      // authMode (so `password` triggers the ROPC token exchange,
      // `basic` just stores the credentials).
      setCustomCredProvider({
        id: provider.id,
        name: provider.displayName,
        schema: (provider.credentialSchema as unknown as JSONSchemaObject) ?? {
          type: "object",
          properties: {
            username: { type: "string", description: "Username" },
            password: { type: "string", description: "Password", format: "password" },
          },
          required: ["username", "password"],
        },
      });
    } else {
      connectMutation.mutate({
        provider: provider.id,
        connectionProfileId: connectionProfileId ?? undefined,
      });
    }
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate({
      provider: provider.id,
      connectionProfileId: connectionProfileId ?? undefined,
    });
  };

  return (
    <>
      {isConnected ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-emerald-500">{t("providers.connected")}</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={handleDisconnect}
            disabled={isPending}
          >
            {t("detail.disconnect", { ns: "agents" })}
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
          {t("detail.connect", { ns: "agents" })}
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
            {
              provider: apiKeyProvider.id,
              apiKey,
              connectionProfileId: connectionProfileId ?? undefined,
            },
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
              {
                provider: customCredProvider.id,
                credentials,
                connectionProfileId: connectionProfileId ?? undefined,
              },
              { onSuccess: () => setCustomCredProvider(null) },
            );
          }}
        />
      )}
    </>
  );
}
