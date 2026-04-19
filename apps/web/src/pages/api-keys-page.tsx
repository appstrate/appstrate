// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { ConfirmModal } from "../components/confirm-modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { useApiKeys, useAvailableScopes, useRevokeApiKey } from "../hooks/use-api-keys";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { ApiKeyCreateModal } from "../components/api-key-create-modal";
import type { ApiKeyInfo } from "@appstrate/shared-types";

function formatDate(iso: string | null): string {
  if (!iso) return "\u2014";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isExpired(expiresAt: string | null): boolean {
  return expiresAt ? new Date(expiresAt) < new Date() : false;
}

export function ApiKeysPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const appId = useCurrentApplicationId();
  const { data: apiKeys, isLoading, error } = useApiKeys();
  const { data: availableScopes } = useAvailableScopes();
  const revokeApiKeyMutation = useRevokeApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<{ id: string; label: string } | null>(null);

  if (!isAdmin) return null;
  if (!appId) return <EmptyState message={t("applications.noAppSelected")} icon={KeyRound} />;

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const handleRevoke = (key: ApiKeyInfo) => {
    setConfirmState({ id: key.id, label: key.name });
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-end gap-4">
        <a
          href="/api/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary text-sm no-underline hover:underline"
        >
          {t("settings:apiKeys.swaggerLink")}
        </a>
        <Button onClick={() => setCreateOpen(true)}>{t("settings:apiKeys.createBtn")}</Button>
      </div>

      {apiKeys && apiKeys.length > 0 ? (
        <div className="flex flex-col gap-3">
          {apiKeys.map((key) => {
            const expired = isExpired(key.expiresAt);
            return (
              <div key={key.id} className="border-border bg-card rounded-lg border p-5">
                <div className="mb-3 flex items-center gap-3">
                  <div className="flex-1">
                    <h3 className="text-[0.95rem] font-semibold">{key.name}</h3>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Badge variant="secondary" className="opacity-60">
                        {key.keyPrefix}...
                      </Badge>
                      {expired ? (
                        <Badge variant="failed">{t("settings:apiKeys.expired")}</Badge>
                      ) : (
                        <Badge variant="success">{t("settings:apiKeys.active")}</Badge>
                      )}
                    </div>
                  </div>
                  {/* Scope badges */}
                  {availableScopes && key.scopes.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {key.scopes.length === availableScopes.length ? (
                        <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                          {t("settings:apiKeys.fullAccess")}
                        </Badge>
                      ) : (
                        [...new Set(key.scopes.map((s) => s.split(":")[0]!))].map((resource) => (
                          <Badge
                            key={resource}
                            variant="outline"
                            className="px-1.5 py-0 text-[0.65rem]"
                          >
                            {resource}
                          </Badge>
                        ))
                      )}
                    </div>
                  )}
                </div>
                <div className="mt-3 flex flex-col gap-1">
                  <span className="text-muted-foreground text-sm">
                    {key.expiresAt
                      ? t("settings:apiKeys.expiresOn", { date: formatDate(key.expiresAt) })
                      : t("settings:apiKeys.neverExpires")}
                  </span>
                  {key.lastUsedAt && (
                    <span className="text-muted-foreground text-sm">
                      {t("settings:apiKeys.lastUsed", { date: formatDate(key.lastUsedAt) })}
                    </span>
                  )}
                  {key.createdByName && (
                    <span className="text-muted-foreground text-sm">
                      {t("settings:apiKeys.createdByLabel", { name: key.createdByName })}
                    </span>
                  )}
                </div>
                <div className="border-border mt-3 flex justify-end gap-2 border-t pt-3">
                  <Button variant="destructive" size="sm" onClick={() => handleRevoke(key)}>
                    {t("settings:apiKeys.revoke")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          message={t("settings:apiKeys.empty")}
          hint={t("settings:apiKeys.emptyHint")}
          icon={KeyRound}
          compact
        >
          <Button onClick={() => setCreateOpen(true)}>{t("settings:apiKeys.createBtn")}</Button>
        </EmptyState>
      )}

      <ApiKeyCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("settings:apiKeys.revokeConfirm", { name: confirmState?.label })}
        isPending={revokeApiKeyMutation.isPending}
        onConfirm={() => {
          if (!confirmState) return;
          revokeApiKeyMutation.mutate(confirmState.id, {
            onSuccess: () => setConfirmState(null),
          });
        }}
      />
    </div>
  );
}
