// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Laptop, Terminal, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";
import { apiFetch } from "../../api";
import { formatDateField } from "../../lib/markdown";

interface CliSession {
  familyId: string;
  deviceName: string | null;
  userAgent: string | null;
  createdIp: string | null;
  lastUsedIp: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

interface CliSessionsResponse {
  sessions: CliSession[];
}

const SESSIONS_QUERY_KEY = ["cli-sessions"] as const;

function categorizeUserAgent(ua: string | null): "cli" | "github-action" | "unknown" {
  if (!ua) return "unknown";
  const lower = ua.toLowerCase();
  // Any GitHub Action invocation surfaces here when the action authenticates
  // via the same `cli_refresh_tokens` family. We branch on the action's UA
  // first because its identifier is a strict substring of the broader CLI
  // category and would otherwise be swallowed.
  if (lower.includes("github-action") || lower.includes("appstrate-action")) {
    return "github-action";
  }
  if (lower.includes("appstrate-cli") || lower.includes("appstrate/")) {
    return "cli";
  }
  return "unknown";
}

function deviceIcon(category: ReturnType<typeof categorizeUserAgent>) {
  switch (category) {
    case "cli":
      return Terminal;
    case "github-action":
      return Monitor;
    default:
      return Laptop;
  }
}

function deriveLabel(session: CliSession, t: (k: string) => string): string {
  if (session.deviceName) return session.deviceName;
  const category = categorizeUserAgent(session.userAgent);
  if (category === "cli") return t("devices.fallbackCli");
  if (category === "github-action") return t("devices.fallbackGithubAction");
  return t("devices.fallbackUnknown");
}

export function PreferencesDevicesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => apiFetch<CliSessionsResponse>("/api/auth/cli/sessions"),
  });

  const revokeOne = useMutation({
    mutationFn: async (familyId: string) =>
      apiFetch<{ revoked: boolean }>("/api/auth/cli/sessions/revoke", {
        method: "POST",
        body: JSON.stringify({ familyId }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  const revokeAll = useMutation({
    mutationFn: async () =>
      apiFetch<{ revokedCount: number }>("/api/auth/cli/sessions/revoke-all", {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  const [pendingRevoke, setPendingRevoke] = useState<CliSession | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const sessions = data?.sessions ?? [];

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-muted-foreground text-sm font-medium">{t("devices.title")}</div>
          <p className="text-muted-foreground mt-1 max-w-prose text-xs">
            {t("devices.description")}
          </p>
        </div>
        {sessions.length > 1 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmRevokeAll(true)}
            disabled={revokeAll.isPending}
          >
            {t("devices.revokeAll")}
          </Button>
        )}
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          icon={Laptop}
          message={t("devices.emptyTitle")}
          hint={t("devices.emptyDescription")}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sessions.map((s) => {
            const category = categorizeUserAgent(s.userAgent);
            const Icon = deviceIcon(category);
            return (
              <div
                key={s.familyId}
                className="border-border bg-card flex items-start gap-4 rounded-lg border p-5"
              >
                <Icon className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{deriveLabel(s, t)}</span>
                    {s.current && (
                      <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-xs font-medium">
                        {t("devices.thisDevice")}
                      </span>
                    )}
                  </div>
                  <div className="text-muted-foreground mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
                    {s.userAgent && (
                      <div className="truncate">
                        <span className="font-medium">{t("devices.userAgentLabel")}:</span>{" "}
                        <span className="font-mono">{s.userAgent}</span>
                      </div>
                    )}
                    {s.createdIp && (
                      <div>
                        <span className="font-medium">{t("devices.createdIpLabel")}:</span>{" "}
                        <span className="font-mono">{s.createdIp}</span>
                      </div>
                    )}
                    <div>
                      <span className="font-medium">{t("devices.createdAtLabel")}:</span>{" "}
                      {formatDateField(s.createdAt)}
                    </div>
                    <div>
                      <span className="font-medium">{t("devices.lastUsedLabel")}:</span>{" "}
                      {s.lastUsedAt ? formatDateField(s.lastUsedAt) : t("devices.neverUsed")}
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingRevoke(s)}
                  disabled={
                    s.current || (revokeOne.isPending && revokeOne.variables === s.familyId)
                  }
                >
                  {t("devices.revoke")}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={pendingRevoke !== null}
        title={t("devices.confirmRevokeTitle")}
        description={t("devices.confirmRevokeDescription", {
          name: pendingRevoke ? deriveLabel(pendingRevoke, t) : "",
        })}
        confirmLabel={t("devices.revoke")}
        variant="destructive"
        isPending={revokeOne.isPending}
        onConfirm={() => {
          if (!pendingRevoke) return;
          revokeOne.mutate(pendingRevoke.familyId, {
            onSuccess: () => setPendingRevoke(null),
          });
        }}
        onClose={() => setPendingRevoke(null)}
      />

      <ConfirmModal
        open={confirmRevokeAll}
        title={t("devices.confirmRevokeAllTitle")}
        description={t("devices.confirmRevokeAllDescription")}
        confirmLabel={t("devices.revokeAll")}
        variant="destructive"
        isPending={revokeAll.isPending}
        onConfirm={() => {
          revokeAll.mutate(undefined, {
            onSuccess: () => setConfirmRevokeAll(false),
          });
        }}
        onClose={() => setConfirmRevokeAll(false)}
      />
    </>
  );
}
