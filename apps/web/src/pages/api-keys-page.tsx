import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { KeyRound, ShieldAlert } from "lucide-react";
import { ConfirmModal } from "../components/confirm-modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useOrg } from "../hooks/use-org";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { AppBreadcrumbSwitcher } from "../components/app-breadcrumb-switcher";
import { useApiKeys, useRevokeApiKey } from "../hooks/use-api-keys";
import { PageHeader } from "../components/page-header";
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
  const { isOrgAdmin } = useOrg();
  const appId = useCurrentApplicationId();
  const { data: apiKeys, isLoading, error } = useApiKeys();
  const revokeApiKeyMutation = useRevokeApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<{ id: string; label: string } | null>(null);

  if (!appId) return <EmptyState message={t("applications.noAppSelected")} icon={KeyRound} />;

  if (!isOrgAdmin) {
    return (
      <EmptyState message={t("settings:orgSettings.adminOnly")} icon={ShieldAlert}>
        <Link to="/">
          <Button variant="outline">{t("common:btn.back")}</Button>
        </Link>
      </EmptyState>
    );
  }

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const handleRevoke = (key: ApiKeyInfo) => {
    setConfirmState({ id: key.id, label: key.name });
  };

  return (
    <>
      <PageHeader
        title={t("settings:apiKeys.pageTitle")}
        emoji="🔑"
        breadcrumbs={[
          { label: t("nav.appSection", { ns: "common" }), href: "/applications" },
          { label: "", node: <AppBreadcrumbSwitcher /> },
          { label: t("settings:apiKeys.pageTitle") },
        ]}
        actions={
          <>
            <a
              href="/api/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary text-sm no-underline hover:underline"
            >
              {t("settings:apiKeys.swaggerLink")}
            </a>
            <Button onClick={() => setCreateOpen(true)}>{t("settings:apiKeys.createBtn")}</Button>
          </>
        }
      />

      {apiKeys && apiKeys.length > 0 ? (
        <div className="flex flex-col gap-3">
          {apiKeys.map((key) => {
            const expired = isExpired(key.expiresAt);
            return (
              <div key={key.id} className="rounded-lg border border-border bg-card p-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex-1">
                    <h3 className="text-[0.95rem] font-semibold">{key.name}</h3>
                    <div className="flex flex-wrap gap-1.5 mt-1">
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
                </div>
                <div className="flex flex-col gap-1 mt-3">
                  <span className="text-sm text-muted-foreground">
                    {key.expiresAt
                      ? t("settings:apiKeys.expiresOn", { date: formatDate(key.expiresAt) })
                      : t("settings:apiKeys.neverExpires")}
                  </span>
                  {key.lastUsedAt && (
                    <span className="text-sm text-muted-foreground">
                      {t("settings:apiKeys.lastUsed", { date: formatDate(key.lastUsedAt) })}
                    </span>
                  )}
                  {key.createdByName && (
                    <span className="text-sm text-muted-foreground">
                      {t("settings:apiKeys.createdByLabel", { name: key.createdByName })}
                    </span>
                  )}
                </div>
                <div className="mt-3 pt-3 border-t border-border flex gap-2 justify-end">
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
    </>
  );
}
