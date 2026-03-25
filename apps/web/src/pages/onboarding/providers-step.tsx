import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  OnboardingLayout,
  useOnboardingGuard,
  useOnboardingNav,
} from "../../components/onboarding-layout";
import { useProviders } from "../../hooks/use-providers";
import { useAvailableProviders } from "../../hooks/use-available-providers";
import { useConnect, useConnectApiKey, useConnectCredentials } from "../../hooks/use-mutations";
import { ApiKeyModal } from "../../components/api-key-modal";
import { CustomCredentialsModal } from "../../components/custom-credentials-modal";
import { ProviderConfigBadge } from "../../components/provider-config-badge";
import { ProviderConfigureButton } from "../../components/provider-configure-button";
import { Spinner } from "../../components/spinner";
import { CheckCircle2 } from "lucide-react";
import { ProviderIcon } from "../../components/provider-icon";
import type { ProviderConfig, JSONSchemaObject } from "@appstrate/shared-types";

export function OnboardingProvidersStep() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const orgId = useOnboardingGuard();
  const { nextRoute, prevRoute } = useOnboardingNav("providers");

  const { data: providersData, isLoading: providersLoading } = useProviders();
  const { data: availableProviders } = useAvailableProviders();

  const connectMutation = useConnect();
  const connectApiKeyMutation = useConnectApiKey();
  const connectCredentialsMutation = useConnectCredentials();

  const [apiKeyProvider, setApiKeyProvider] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [customCredProvider, setCustomCredProvider] = useState<{
    id: string;
    name: string;
    schema: JSONSchemaObject;
  } | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);

  const providers = providersData?.providers ?? [];

  const getAvailableProviderStatus = (providerId: string) => {
    return availableProviders?.find((s) => s.provider === providerId);
  };

  const handleConnect = (provider: ProviderConfig) => {
    if (provider.authMode === "api_key") {
      setApiKeyProvider({ id: provider.id, name: provider.displayName });
    } else if (
      (provider.authMode === "custom" || provider.authMode === "basic") &&
      provider.credentialSchema
    ) {
      setCustomCredProvider({
        id: provider.id,
        name: provider.displayName,
        schema: provider.credentialSchema as unknown as JSONSchemaObject,
      });
    } else {
      setConnectingProvider(provider.id);
      connectMutation.mutate(
        { provider: provider.id },
        { onSettled: () => setConnectingProvider(null) },
      );
    }
  };

  const goNext = () => nextRoute && navigate(nextRoute);

  if (!orgId) return null;

  return (
    <OnboardingLayout
      step="providers"
      title={t("onboarding.providersTitle")}
      subtitle={t("onboarding.providersSubtitle")}
      onNext={goNext}
      onBack={prevRoute ? () => navigate(prevRoute) : undefined}
    >
      {providersLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : providers.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          {t("onboarding.noProviders")}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {providers.map((provider) => {
            const availableProvider = getAvailableProviderStatus(provider.id);
            const isConnected = availableProvider?.status === "connected";
            const isConnecting = connectingProvider === provider.id;

            return (
              <div key={provider.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center gap-3">
                  {provider.iconUrl && <ProviderIcon src={provider.iconUrl} className="size-8" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold truncate">{provider.displayName}</h3>
                      <ProviderConfigBadge enabled={provider.enabled} />
                    </div>
                    {provider.categories && provider.categories.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {provider.categories.join(", ")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {isConnected ? (
                      <Badge variant="success" className="flex items-center gap-1">
                        <CheckCircle2 size={12} />
                        {t("providers.connected")}
                      </Badge>
                    ) : provider.enabled ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleConnect(provider)}
                        disabled={isConnecting}
                      >
                        {isConnecting ? <Spinner /> : t("btn.connect")}
                      </Button>
                    ) : null}
                    <ProviderConfigureButton
                      provider={provider}
                      callbackUrl={providersData?.callbackUrl}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ApiKeyModal
        open={!!apiKeyProvider}
        onClose={() => setApiKeyProvider(null)}
        providerName={apiKeyProvider?.name ?? ""}
        isPending={connectApiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          if (!apiKeyProvider) return;
          connectApiKeyMutation.mutate(
            { provider: apiKeyProvider.id, apiKey },
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
              { provider: customCredProvider.id, credentials },
              { onSuccess: () => setCustomCredProvider(null) },
            );
          }}
        />
      )}
    </OnboardingLayout>
  );
}
