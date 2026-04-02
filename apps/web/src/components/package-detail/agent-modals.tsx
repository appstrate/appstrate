// SPDX-License-Identifier: Apache-2.0

import type { JSONSchemaObject } from "@appstrate/core/form";
import { usePackageDetail } from "../../hooks/use-packages";
import { useConnectApiKey, useConnectCredentials } from "../../hooks/use-mutations";
import { useAgentDetailUI } from "../../stores/agent-detail-ui-store";
import { ApiKeyModal } from "../api-key-modal";
import { CustomCredentialsModal } from "../custom-credentials-modal";

export function AgentModals({ packageId }: { packageId: string }) {
  const { data: detail } = usePackageDetail("agent", packageId);
  const populatedProviders = detail?.populatedProviders;

  const apiKeyMutation = useConnectApiKey();
  const credentialsMutation = useConnectCredentials();

  const { apiKeyService, setApiKeyService, customCredService, setCustomCredService } =
    useAgentDetailUI();

  if (!detail) return null;

  const customCredProviderDef = customCredService
    ? populatedProviders?.[customCredService.provider]
    : undefined;
  const customCredSchema = customCredProviderDef?.credentialSchema as JSONSchemaObject | undefined;

  return (
    <>
      <ApiKeyModal
        open={!!apiKeyService}
        onClose={() => setApiKeyService(null)}
        providerName={apiKeyService?.id ?? ""}
        isPending={apiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          if (apiKeyService) {
            apiKeyMutation.mutate(
              { provider: apiKeyService.provider, apiKey },
              { onSuccess: () => setApiKeyService(null) },
            );
          }
        }}
      />
      {customCredService && customCredSchema && (
        <CustomCredentialsModal
          open
          onClose={() => setCustomCredService(null)}
          schema={customCredSchema}
          providerId={customCredService.id}
          providerName={customCredService.name}
          isPending={credentialsMutation.isPending}
          onSubmit={(credentials) => {
            credentialsMutation.mutate(
              { provider: customCredService.provider, credentials },
              { onSuccess: () => setCustomCredService(null) },
            );
          }}
        />
      )}
    </>
  );
}
