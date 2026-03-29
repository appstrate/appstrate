import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { useProviders } from "../hooks/use-providers";
import { useProviderConnection } from "../hooks/use-provider-connection";
import type { JSONSchemaObject } from "@appstrate/core/form";

interface ProviderConnectionCardProps {
  providerId: string;
  /** Flow package ID — enables per-provider profile persistence. */
  packageId?: string;
  /** Org profile ID — enables the org binding section. */
  orgProfileId?: string;
  /** Org profile display name — shown in the bind button. */
  orgProfileName?: string;
  /** When true, hide all action buttons — card becomes purely informational. */
  readOnly?: boolean;
}

export function ProviderConnectionCard({
  providerId,
  packageId,
  orgProfileId,
  orgProfileName,
  readOnly: readOnlyProp,
}: ProviderConnectionCardProps) {
  const { t } = useTranslation(["settings", "flows"]);

  const {
    isOrgAdmin,
    userProfiles,
    hasMultipleProfiles,
    effectiveProfileId,
    isConnected,
    binding,
    isBoundButDisconnected,
    isEffectivelyBound,
    connectMutation,
    connectApiKeyMutation,
    connectCredentialsMutation,
    disconnectMutation,
    isPending,
    profileParam,
    handleProfileChange,
    doBind,
    handleUnbind,
    readOnly,
  } = useProviderConnection({ providerId, packageId, orgProfileId, readOnly: readOnlyProp });

  // Provider metadata
  const { data: providersData } = useProviders();
  const provider = providersData?.providers?.find((p) => p.id === providerId);

  // Modal state
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [customCredOpen, setCustomCredOpen] = useState(false);

  const displayName = provider?.displayName ?? providerId;
  const iconUrl = provider?.iconUrl;
  const authMode = provider?.authMode;
  const credentialSchema = provider?.credentialSchema as JSONSchemaObject | undefined;

  const handleConnect = () => {
    if (authMode === "api_key") {
      setApiKeyOpen(true);
    } else if (authMode === "custom" && credentialSchema) {
      setCustomCredOpen(true);
    } else {
      connectMutation.mutate({ provider: providerId, ...profileParam });
    }
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate({ provider: providerId, ...profileParam });
  };

  // ─── Determine active mode: org-bound or user-managed ────

  const isOrgMode = isEffectivelyBound || isBoundButDisconnected;

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

        <div className="flex-1" />

        {isOrgMode ? (
          /* ─── Org-bound mode: show binding info ──────────── */
          <>
            {isBoundButDisconnected ? (
              <span className="inline-flex items-center gap-1 text-xs text-destructive shrink-0">
                <AlertTriangle className="size-3" />
                {!isOrgAdmin
                  ? t("providerCard.boundDisconnectedUser")
                  : t("providerCard.boundDisconnected")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-primary shrink-0">
                <Building2 className="size-3" />
                {binding!.boundByUserName
                  ? `${binding!.boundByUserName} — ${binding!.sourceProfileName}`
                  : binding!.sourceProfileName}
              </span>
            )}
            {!readOnly && isOrgAdmin && (
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
          </>
        ) : (
          /* ─── User-managed mode: profile selector + connect/disconnect ── */
          <>
            {isConnected ? (
              <span className="inline-flex items-center gap-1 text-xs text-success shrink-0">
                <CheckCircle2 className="size-3" />
                {t("providers.connected")}
              </span>
            ) : readOnly ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                <AlertTriangle className="size-3" />
                {t("services.notConnected")}
              </span>
            ) : null}

            {!readOnly && hasMultipleProfiles && (
              <Select value={effectiveProfileId ?? ""} onValueChange={handleProfileChange}>
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
                {isConnected && orgProfileId && isOrgAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={doBind}
                    disabled={isPending || !effectiveProfileId}
                  >
                    <Building2 className="size-3 mr-1" />
                    {orgProfileName
                      ? t("providerCard.bindTo", { name: orgProfileName })
                      : t("providerCard.bind")}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <ApiKeyModal
        open={apiKeyOpen}
        onClose={() => setApiKeyOpen(false)}
        providerName={displayName}
        isPending={connectApiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          connectApiKeyMutation.mutate(
            { provider: providerId, apiKey, ...profileParam },
            { onSuccess: () => setApiKeyOpen(false) },
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
              { onSuccess: () => setCustomCredOpen(false) },
            );
          }}
        />
      )}
    </>
  );
}
