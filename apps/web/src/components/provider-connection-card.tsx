// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, AlertTriangle, Unlink, Plug, Building2, Shield } from "lucide-react";
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
import { resolveScopeLabel } from "../lib/scope-labels";
import type { JSONSchemaObject } from "@appstrate/core/form";

interface ProviderConnectionCardProps {
  providerId: string;
  /** Agent package ID — enables per-provider profile persistence. */
  packageId?: string;
  /** App profile ID — enables the app binding section. */
  appProfileId?: string;
  /** App profile display name — shown in the bind button. */
  appProfileName?: string;
  /** When true, hide all action buttons — card becomes purely informational. */
  readOnly?: boolean;
  /** Profile ID to check connection status for (e.g. schedule owner's profile). */
  viewProfileId?: string;
  /** Scopes required by the agent for this provider. */
  scopesRequired?: string[];
  /** Scopes missing from the current connection (subset of scopesRequired). */
  scopesMissing?: string[];
}

export function ProviderConnectionCard({
  providerId,
  packageId,
  appProfileId,
  appProfileName,
  readOnly: readOnlyProp,
  viewProfileId,
  scopesRequired,
  scopesMissing,
}: ProviderConnectionCardProps) {
  const { t } = useTranslation(["settings", "agents"]);

  const {
    userProfiles,
    hasMultipleProfiles,
    effectiveProfileId,
    isConnected,
    needsReconnection,
    profileConnections,
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
  } = useProviderConnection({
    providerId,
    packageId,
    appProfileId,
    readOnly: readOnlyProp,
    viewProfileId,
  });

  // Provider metadata
  const { data: providers } = useProviders();
  const provider = providers?.find((p) => p.id === providerId);

  // Modal state
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [customCredOpen, setCustomCredOpen] = useState(false);

  const displayName = provider?.displayName ?? providerId;
  const iconUrl = provider?.iconUrl;
  const authMode = provider?.authMode;
  const credentialSchema = provider?.credentialSchema as JSONSchemaObject | undefined;
  const availableScopes = provider?.availableScopes;

  const hasMissingScopes = scopesMissing && scopesMissing.length > 0;

  const handleConnect = () => {
    if (authMode === "api_key") {
      setApiKeyOpen(true);
    } else if (authMode === "custom" && credentialSchema) {
      setCustomCredOpen(true);
    } else {
      connectMutation.mutate({
        provider: providerId,
        ...(scopesRequired ? { scopes: scopesRequired } : {}),
        ...profileParam,
      });
    }
  };

  const handleDisconnect = () => {
    const conn = profileConnections?.find((c) => c.providerId === providerId);
    if (!conn) return;
    disconnectMutation.mutate({
      provider: providerId,
      ...profileParam,
      connectionId: conn.id,
    });
  };

  // ─── Determine active mode: org-bound or user-managed ────

  const isOrgMode = isEffectivelyBound || isBoundButDisconnected;

  return (
    <>
      <div className="border-border bg-card flex items-center gap-2 rounded-lg border px-3 py-2.5">
        {/* Provider icon + name */}
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {iconUrl ? (
            <ProviderIcon src={iconUrl} className="size-5 shrink-0" />
          ) : (
            <Plug className="text-muted-foreground size-4 shrink-0" />
          )}
          <span className="truncate text-sm font-medium">{displayName}</span>
        </div>

        <div className="flex-1" />

        {isOrgMode ? (
          /* ─── Org-bound mode: show binding info ──────────── */
          <>
            {isBoundButDisconnected ? (
              <span className="text-destructive inline-flex shrink-0 items-center gap-1 text-xs">
                <AlertTriangle className="size-3" />
                {t("providerCard.boundDisconnected")}
              </span>
            ) : (
              <span className="text-primary inline-flex shrink-0 items-center gap-1 text-xs">
                <Building2 className="size-3" />
                {binding?.boundByUserName
                  ? `${binding.boundByUserName} — ${binding.sourceProfileName}`
                  : binding?.sourceProfileName}
              </span>
            )}
            {!readOnly && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleUnbind}
                disabled={isPending}
              >
                <Unlink className="mr-1 size-3" />
                {t("providerCard.unbind")}
              </Button>
            )}
          </>
        ) : (
          /* ─── User-managed mode: profile selector + connect/disconnect ── */
          <>
            {needsReconnection ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-amber-500">
                <AlertTriangle className="size-3" />
                {t("providers.needsReconnection")}
              </span>
            ) : isConnected ? (
              <div className="flex shrink-0 items-center gap-2">
                {hasMissingScopes ? (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-500">
                    <AlertTriangle className="size-3" />
                    {t("providerCard.scopesMissing", { ns: "agents" })}
                  </span>
                ) : (
                  <span className="text-success inline-flex items-center gap-1 text-xs">
                    <CheckCircle2 className="size-3" />
                    {t("providers.connected")}
                  </span>
                )}
                {scopesMissing && scopesMissing.length > 0 && (
                  <div className="flex items-center gap-1">
                    <Shield className="size-3 text-amber-500" />
                    {scopesMissing.map((scope) => {
                      const label = resolveScopeLabel(scope, availableScopes);
                      const isRaw = label === scope;
                      return (
                        <span
                          key={scope}
                          title={isRaw ? undefined : scope}
                          className={`rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500 ${isRaw ? "font-mono" : ""}`}
                        >
                          {label}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : readOnly ? (
              <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs">
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
              <div className="flex shrink-0 items-center gap-1.5">
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
                {isConnected && hasMissingScopes && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 border-amber-500/50 px-2 text-xs text-amber-500 hover:bg-amber-500/10"
                    onClick={handleConnect}
                    disabled={isPending}
                  >
                    <Shield className="mr-1 size-3" />
                    {t("providerCard.updatePermissions", { ns: "agents" })}
                  </Button>
                )}
                {isConnected && !hasMissingScopes && (
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
                {isConnected && appProfileId && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={doBind}
                    disabled={isPending || !effectiveProfileId}
                  >
                    <Building2 className="mr-1 size-3" />
                    {appProfileName
                      ? t("providerCard.bindTo", { name: appProfileName })
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
