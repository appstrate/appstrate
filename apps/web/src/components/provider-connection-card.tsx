import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, AlertTriangle, Link2, Unlink, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProviderIcon } from "./provider-icon";
import { ApiKeyModal } from "./api-key-modal";
import { CustomCredentialsModal } from "./custom-credentials-modal";
import {
  useConnect,
  useConnectApiKey,
  useConnectCredentials,
  useDisconnect,
} from "../hooks/use-mutations";
import { useProviders } from "../hooks/use-providers";
import {
  useConnectionProfiles,
  useProfileConnections,
  useOrgProfileBindings,
  useBindOrgProvider,
  useUnbindOrgProvider,
} from "../hooks/use-connection-profiles";
import type { JSONSchemaObject } from "@appstrate/core/form";

interface ProviderConnectionCardProps {
  providerId: string;
  orgProfileId?: string;
}

export function ProviderConnectionCard({ providerId, orgProfileId }: ProviderConnectionCardProps) {
  const { t } = useTranslation(["settings", "flows"]);
  const qc = useQueryClient();

  // User profiles
  const { data: userProfiles } = useConnectionProfiles();
  const defaultProfile = userProfiles?.find((p) => p.isDefault);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const effectiveProfileId = selectedProfileId ?? defaultProfile?.id ?? null;
  const hasMultipleProfiles = (userProfiles?.length ?? 0) > 1;

  // Provider metadata
  const { data: providersData } = useProviders();
  const provider = providersData?.providers?.find((p) => p.id === providerId);

  // Connection status — scoped to the selected profile
  const { data: profileConnections } = useProfileConnections(effectiveProfileId);
  const isConnected = profileConnections?.some((c) => c.providerId === providerId) ?? false;

  // Binding status (only when orgProfileId is provided)
  const { data: bindings } = useOrgProfileBindings(orgProfileId);
  const binding = bindings?.find((b) => b.providerId === providerId);
  const isBound = !!binding;

  // Mutations
  const connectMutation = useConnect();
  const connectApiKeyMutation = useConnectApiKey();
  const connectCredentialsMutation = useConnectCredentials();
  const disconnectMutation = useDisconnect();
  const bindMutation = useBindOrgProvider();
  const unbindMutation = useUnbindOrgProvider();

  // Modal state
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [customCredOpen, setCustomCredOpen] = useState(false);

  const isPending =
    connectMutation.isPending ||
    connectApiKeyMutation.isPending ||
    connectCredentialsMutation.isPending ||
    disconnectMutation.isPending ||
    bindMutation.isPending ||
    unbindMutation.isPending;

  const displayName = provider?.displayName ?? providerId;
  const iconUrl = provider?.iconUrl;
  const authMode = provider?.authMode;
  const credentialSchema = provider?.credentialSchema as JSONSchemaObject | undefined;

  const profileParam = effectiveProfileId ? { profileId: effectiveProfileId } : {};

  const invalidateConnections = () => {
    qc.invalidateQueries({ queryKey: ["profile-connections"] });
    qc.invalidateQueries({ queryKey: ["available-providers"] });
  };

  const doBind = () => {
    if (!orgProfileId || !effectiveProfileId) return;
    bindMutation.mutate({
      profileId: orgProfileId,
      providerId,
      sourceProfileId: effectiveProfileId,
    });
  };

  const handleConnect = () => {
    if (authMode === "api_key") {
      setApiKeyOpen(true);
    } else if (authMode === "custom" && credentialSchema) {
      setCustomCredOpen(true);
    } else {
      connectMutation.mutate(
        { provider: providerId, ...profileParam },
        {
          onSuccess: () => invalidateConnections(),
        },
      );
    }
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate(
      { provider: providerId, ...profileParam },
      {
        onSuccess: () => invalidateConnections(),
      },
    );
  };

  const handleConnectAndBind = () => {
    if (authMode === "api_key") {
      setApiKeyOpen(true);
    } else if (authMode === "custom" && credentialSchema) {
      setCustomCredOpen(true);
    } else {
      connectMutation.mutate(
        { provider: providerId, ...profileParam },
        {
          onSuccess: () => {
            invalidateConnections();
            doBind();
          },
        },
      );
    }
  };

  const handleUnbind = () => {
    if (!orgProfileId) return;
    unbindMutation.mutate({ profileId: orgProfileId, providerId });
  };

  return (
    <>
      <div className="flex items-center gap-2 py-2.5 px-3 rounded-lg border border-border bg-card">
        {/* Provider icon + name */}
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          {iconUrl ? (
            <ProviderIcon src={iconUrl} className="size-5 shrink-0" />
          ) : (
            <Plug className="size-4 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-medium truncate">{displayName}</span>
        </div>

        {/* Status */}
        {orgProfileId ? (
          isBound && binding ? (
            <span className="inline-flex items-center gap-1 text-xs text-primary shrink-0">
              <Link2 className="size-3" />
              {binding.boundByUserName
                ? `${binding.boundByUserName} — ${binding.sourceProfileName}`
                : binding.sourceProfileName}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-warning shrink-0">
              <AlertTriangle className="size-3" />
              {t("providerCard.notBound")}
            </span>
          )
        ) : isConnected ? (
          <span className="inline-flex items-center gap-1 text-xs text-success shrink-0">
            <CheckCircle2 className="size-3" />
            {t("providers.connected")}
          </span>
        ) : null}

        <div className="flex-1" />

        {/* Profile selector — shown when multiple profiles and not yet bound */}
        {hasMultipleProfiles && !isBound && (
          <Select value={effectiveProfileId ?? ""} onValueChange={setSelectedProfileId}>
            <SelectTrigger className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {userProfiles?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                  {p.isDefault ? ` (${t("providerCard.default")})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          {!isConnected && !orgProfileId && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleConnect}
              disabled={isPending || !provider?.enabled || !effectiveProfileId}
            >
              {t("providerCard.connect")}
            </Button>
          )}

          {!isConnected && orgProfileId && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleConnectAndBind}
              disabled={isPending || !provider?.enabled || !effectiveProfileId}
            >
              {t("providerCard.connectAndBind")}
            </Button>
          )}

          {isConnected && !orgProfileId && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleDisconnect}
              disabled={isPending}
            >
              {t("providerCard.disconnect")}
            </Button>
          )}

          {isConnected && orgProfileId && !isBound && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={doBind}
              disabled={isPending || !effectiveProfileId}
            >
              <Link2 className="size-3 mr-1" />
              {t("providerCard.bind")}
            </Button>
          )}

          {isConnected && orgProfileId && isBound && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleUnbind}
              disabled={isPending}
            >
              <Unlink className="size-3 mr-1" />
              {t("providerCard.unbind")}
            </Button>
          )}
        </div>
      </div>

      <ApiKeyModal
        open={apiKeyOpen}
        onClose={() => setApiKeyOpen(false)}
        providerName={displayName}
        isPending={connectApiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          connectApiKeyMutation.mutate(
            { provider: providerId, apiKey, ...profileParam },
            {
              onSuccess: () => {
                setApiKeyOpen(false);
                invalidateConnections();
                if (orgProfileId) doBind();
              },
            },
          );
        }}
      />

      {credentialSchema && (
        <CustomCredentialsModal
          open={customCredOpen}
          onClose={() => setCustomCredOpen(false)}
          schema={credentialSchema}
          providerId={providerId}
          providerName={displayName}
          isPending={connectCredentialsMutation.isPending}
          onSubmit={(credentials) => {
            connectCredentialsMutation.mutate(
              { provider: providerId, credentials, ...profileParam },
              {
                onSuccess: () => {
                  setCustomCredOpen(false);
                  invalidateConnections();
                  if (orgProfileId) doBind();
                },
              },
            );
          }}
        />
      )}
    </>
  );
}
