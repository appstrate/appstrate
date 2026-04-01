import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, AlertTriangle, Unlink, Plug, Building2 } from "lucide-react";
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
  /** Org profile ID — enables the org binding section (admin-only). */
  orgProfileId?: string;
  /** Org profile display name — shown in the bind button. */
  orgProfileName?: string;
  /** User profile ID to use for connections. When omitted, uses the user's default profile. */
  profileId?: string | null;
  /** When true, hide all action buttons — display-only mode for non-admin users. */
  readOnly?: boolean;
}

export function ProviderConnectionCard({
  providerId,
  orgProfileId,
  orgProfileName,
  profileId: profileIdProp,
  readOnly = false,
}: ProviderConnectionCardProps) {
  const { t } = useTranslation(["settings", "flows"]);
  const qc = useQueryClient();

  // User profile: local selection, prop override, or default
  const { data: userProfiles } = useConnectionProfiles();
  const defaultProfile = userProfiles?.find((p) => p.isDefault);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const effectiveProfileId = profileIdProp ?? selectedProfileId ?? defaultProfile?.id ?? null;
  const hasMultipleProfiles = (userProfiles?.length ?? 0) > 1;

  // Provider metadata
  const { data: providersData } = useProviders();
  const provider = providersData?.providers?.find((p) => p.id === providerId);

  // Connection status — scoped to the user's profile
  const { data: profileConnections } = useProfileConnections(effectiveProfileId);
  const isConnected = profileConnections?.some((c) => c.providerId === providerId) ?? false;

  // Binding status (only when orgProfileId is provided)
  const { data: bindings } = useOrgProfileBindings(orgProfileId);
  const binding = bindings?.find((b) => b.providerId === providerId);
  const isBound = !!binding;
  const isBoundButDisconnected = isBound && binding?.connected === false;
  const isEffectivelyBound = isBound && !isBoundButDisconnected;

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
        { onSuccess: () => invalidateConnections() },
      );
    }
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate(
      { provider: providerId, ...profileParam },
      { onSuccess: () => invalidateConnections() },
    );
  };

  const handleUnbind = () => {
    if (!orgProfileId) return;
    unbindMutation.mutate({ profileId: orgProfileId, providerId });
  };

  // ─── Org binding status (right side) ─────────────────────

  let orgSection: React.ReactNode = null;
  if (orgProfileId && !readOnly) {
    // Admin view: show binding status + actions
    if (isBoundButDisconnected) {
      orgSection = (
        <div className="flex items-center gap-1.5 shrink-0 border-l border-border pl-3 ml-1">
          <span className="inline-flex items-center gap-1 text-xs text-destructive">
            <AlertTriangle className="size-3" />
            {t("providerCard.boundDisconnected", {
              defaultValue: "Org binding broken",
            })}
          </span>
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
        </div>
      );
    } else if (isEffectivelyBound) {
      orgSection = (
        <div className="flex items-center gap-1.5 shrink-0 border-l border-border pl-3 ml-1">
          <span className="inline-flex items-center gap-1 text-xs text-primary">
            <Building2 className="size-3" />
            {binding!.boundByUserName
              ? `${binding!.boundByUserName} — ${binding!.sourceProfileName}`
              : binding!.sourceProfileName}
          </span>
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
        </div>
      );
    } else if (isConnected) {
      orgSection = (
        <div className="flex items-center gap-1.5 shrink-0 border-l border-border pl-3 ml-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={doBind}
            disabled={isPending || !effectiveProfileId}
          >
            <Building2 className="size-3 mr-1" />
            {orgProfileName
              ? t("providerCard.bindTo", {
                  defaultValue: "Share with {{name}}",
                  name: orgProfileName,
                })
              : t("providerCard.bind", { defaultValue: "Share with org" })}
          </Button>
        </div>
      );
    }
  } else if (orgProfileId && readOnly) {
    // User view: read-only binding info
    if (isBoundButDisconnected) {
      orgSection = (
        <span className="inline-flex items-center gap-1 text-xs text-destructive shrink-0">
          <AlertTriangle className="size-3" />
          {t("providerCard.boundDisconnectedUser", {
            defaultValue: "Org connection unavailable — contact your administrator",
          })}
        </span>
      );
    } else if (isEffectivelyBound) {
      orgSection = (
        <span className="inline-flex items-center gap-1 text-xs text-primary shrink-0">
          <Building2 className="size-3" />
          {binding!.boundByUserName
            ? `${binding!.boundByUserName} — ${binding!.sourceProfileName}`
            : binding!.sourceProfileName}
        </span>
      );
    }
  }

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

        {/* Personal connection status */}
        {isConnected ? (
          <span className="inline-flex items-center gap-1 text-xs text-success shrink-0">
            <CheckCircle2 className="size-3" />
            {t("providers.connected")}
          </span>
        ) : null}

        <div className="flex-1" />

        {/* Profile selector — shown when user has multiple profiles */}
        {!readOnly && hasMultipleProfiles && (
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

        {/* Personal connection actions */}
        {!readOnly && (
          <div className="flex items-center gap-1.5 shrink-0">
            {!isConnected && (
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
            {isConnected && (
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
          </div>
        )}

        {/* Org binding section (separated visually) */}
        {orgSection}
      </div>

      {!readOnly && (
        <>
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
                    },
                  },
                );
              }}
            />
          )}
        </>
      )}
    </>
  );
}
