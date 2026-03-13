import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useRegistryStatus,
  useRegistryConnect,
  useRegistryDisconnect,
  useRegistryScopes,
  useClaimScope,
} from "../hooks/use-registry";
import { LoadingState, EmptyState } from "./page-states";
import { Spinner } from "./spinner";

export function RegistrySettings() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: status, isLoading: statusLoading } = useRegistryStatus();
  const connectMutation = useRegistryConnect();
  const disconnectMutation = useRegistryDisconnect();
  const { data: scopes, isLoading: scopesLoading } = useRegistryScopes();
  const claimScopeMutation = useClaimScope();
  const [newScopeName, setNewScopeName] = useState("");

  if (statusLoading) return <LoadingState />;

  if (!status) {
    return <EmptyState message={t("registry.notConfigured")} icon={Store} compact />;
  }

  if (!status.connected) {
    return (
      <>
        <div className="rounded-lg border border-border bg-card p-5 mb-4">
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t("registry.description")}</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 mb-4">
          <Button onClick={() => connectMutation.mutate()} disabled={connectMutation.isPending}>
            {connectMutation.isPending ? <Spinner /> : t("registry.connect")}
          </Button>
        </div>
      </>
    );
  }

  const handleClaimScope = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newScopeName.trim();
    if (!trimmed) return;
    claimScopeMutation.mutate(trimmed, {
      onSuccess: () => setNewScopeName(""),
    });
  };

  return (
    <>
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex-1">
            <h3 className="text-[0.95rem] font-semibold">{status.username}</h3>
            <span className="text-sm text-muted-foreground">
              {status.expired
                ? t("registry.expired")
                : status.expiresAt
                  ? t("registry.expiresAt", {
                      date: new Date(status.expiresAt).toLocaleDateString(),
                    })
                  : t("registry.connected")}
            </span>
          </div>
          <Button
            variant="outline"
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
          >
            {t("registry.disconnect")}
          </Button>
        </div>
      </div>

      <div className="text-sm font-medium text-muted-foreground mb-4 mt-6">
        {t("registry.scopes")}
      </div>
      {scopesLoading ? (
        <LoadingState />
      ) : scopes && scopes.length > 0 ? (
        <div className="flex flex-col gap-3">
          {scopes.map((s) => (
            <div key={s.name} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <h3 className="text-sm font-semibold">{s.name}</h3>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState message={t("registry.noScopes")} icon={ShieldCheck} compact />
      )}

      <div className="rounded-lg border border-border bg-card p-5 mb-4 mt-4">
        <form onSubmit={handleClaimScope} className="flex items-center gap-2 py-1">
          <Input
            type="text"
            value={newScopeName}
            onChange={(e) => setNewScopeName(e.target.value)}
            placeholder={t("registry.scopeName")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newScopeName.trim() && !claimScopeMutation.isPending)
                handleClaimScope(e);
            }}
          />
          <Button type="submit" disabled={claimScopeMutation.isPending || !newScopeName.trim()}>
            {claimScopeMutation.isPending ? <Spinner /> : t("registry.createScope")}
          </Button>
        </form>
      </div>
    </>
  );
}
