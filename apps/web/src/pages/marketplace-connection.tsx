import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, RefreshCw, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useRegistryStatus,
  useRegistryConnect,
  useRegistryDisconnect,
  useRegistryScopes,
  useClaimScope,
} from "../hooks/use-registry";
import { LoadingState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";
import { useQueryClient } from "@tanstack/react-query";

function StatusBadge({ status }: { status: "connected" | "expired" | "disconnected" }) {
  const { t } = useTranslation(["settings"]);
  const labels: Record<string, string> = {
    connected: t("registry.statusConnected"),
    expired: t("registry.statusExpired"),
    disconnected: t("registry.statusDisconnected"),
  };
  const colors: Record<string, string> = {
    connected: "bg-success/10 text-success border-success/20",
    expired: "bg-warning/10 text-warning border-warning/20",
    disconnected: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        colors[status],
      )}
    >
      {labels[status]}
    </span>
  );
}

export function MarketplaceConnectionPage() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const { data: status, isLoading: statusLoading } = useRegistryStatus();
  const connectMutation = useRegistryConnect();
  const disconnectMutation = useRegistryDisconnect();
  const { data: scopes, isLoading: scopesLoading } = useRegistryScopes();
  const claimScopeMutation = useClaimScope();
  const [newScopeName, setNewScopeName] = useState("");
  const [testResult, setTestResult] = useState<"success" | "failed" | null>(null);
  const [testing, setTesting] = useState(false);

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await queryClient.invalidateQueries({ queryKey: ["registry", "status"] });
      const fresh = queryClient.getQueryData<{
        connected: boolean;
        expired?: boolean;
      }>(["registry", "status"]);
      setTestResult(fresh?.connected && !fresh?.expired ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleClaimScope = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newScopeName.trim();
    if (!trimmed) return;
    claimScopeMutation.mutate(trimmed, {
      onSuccess: () => setNewScopeName(""),
    });
  };

  if (statusLoading) {
    return (
      <div className="max-w-[900px]">
        <LoadingState />
      </div>
    );
  }

  const connectionStatus: "connected" | "expired" | "disconnected" = status?.connected
    ? status.expired
      ? "expired"
      : "connected"
    : "disconnected";

  return (
    <div className="max-w-[900px]">
      <Link
        to="/marketplace"
        className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4 hover:text-foreground"
      >
        <ArrowLeft size={14} />
        <span>{t("marketplace.backToMarketplace")}</span>
      </Link>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">{t("marketplace.connectionTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("marketplace.connectionDesc")}</p>
        </div>
      </div>

      {!status || !status.connected ? (
        <>
          <div className="rounded-lg border border-border bg-card p-4 mb-4">
            <p className="text-sm text-muted-foreground">{t("registry.description")}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={connectionStatus} />
            <Button onClick={() => connectMutation.mutate()} disabled={connectMutation.isPending}>
              {connectMutation.isPending ? <Spinner /> : t("registry.connect")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-card p-4 mb-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">{status.username}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <StatusBadge status={connectionStatus} />
                  {status.expiresAt && (
                    <span className="text-xs text-muted-foreground">
                      {t("registry.expiresAt", {
                        date: new Date(status.expiresAt).toLocaleDateString(),
                      })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestConnection}
                  disabled={testing}
                >
                  {testing ? <Spinner /> : <RefreshCw size={14} />}
                  {t("registry.testConnection")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                >
                  {t("registry.disconnect")}
                </Button>
              </div>
            </div>
            {testResult && (
              <div
                className={cn(
                  "mt-3 rounded-md px-3 py-2 text-sm",
                  testResult === "success"
                    ? "bg-success/10 text-success"
                    : "bg-destructive/10 text-destructive",
                )}
              >
                {testResult === "success" ? t("registry.testSuccess") : t("registry.testFailed")}
              </div>
            )}
          </div>

          <div className="text-sm font-medium text-muted-foreground mb-4 mt-6">
            {t("registry.scopes")}
          </div>
          {scopesLoading ? (
            <LoadingState />
          ) : scopes && scopes.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {scopes.map((s) => (
                <div key={s.name} className="rounded-lg border border-border bg-card px-4 py-3">
                  <h3 className="text-sm font-semibold">{s.name}</h3>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message={t("registry.noScopes")} icon={ShieldCheck} compact />
          )}

          <div className="rounded-lg border border-border bg-card p-4 mt-4">
            <form onSubmit={handleClaimScope} className="flex items-center gap-2">
              <Input
                type="text"
                value={newScopeName}
                onChange={(e) => setNewScopeName(e.target.value)}
                placeholder={t("registry.scopeName")}
                className="flex-1"
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
      )}
    </div>
  );
}
