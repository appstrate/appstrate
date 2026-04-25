// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Laptop, Terminal, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";
import { api } from "../../api";
import { useOrg } from "../../hooks/use-org";
import { formatDateField } from "../../lib/markdown";

interface AdminCliSession {
  familyId: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  deviceName: string | null;
  userAgent: string | null;
  createdIp: string | null;
  lastUsedIp: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

interface AdminCliSessionsResponse {
  sessions: AdminCliSession[];
}

function categorizeUserAgent(ua: string | null): "cli" | "github-action" | "unknown" {
  if (!ua) return "unknown";
  const lower = ua.toLowerCase();
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

function displayIp(ip: string | null): string | null {
  if (!ip) return null;
  return ip === "unknown" ? null : ip;
}

function deriveLabel(session: AdminCliSession, t: (k: string) => string): string {
  if (session.deviceName) return session.deviceName;
  const category = categorizeUserAgent(session.userAgent);
  if (category === "cli") return t("devices.fallbackCli");
  if (category === "github-action") return t("devices.fallbackGithubAction");
  return t("devices.fallbackUnknown");
}

export function OrgSettingsCliSessionsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const { data, isLoading, error } = useQuery({
    queryKey: ["org-cli-sessions", orgId],
    queryFn: () => api<AdminCliSessionsResponse>(`/orgs/${orgId}/cli-sessions`),
    enabled: !!orgId,
  });

  const revoke = useMutation({
    mutationFn: async (familyId: string) =>
      api<void>(`/orgs/${orgId}/cli-sessions/${familyId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org-cli-sessions", orgId] });
    },
  });

  const [pendingRevoke, setPendingRevoke] = useState<AdminCliSession | null>(null);

  if (!orgId) return <LoadingState />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const sessions = data?.sessions ?? [];

  return (
    <>
      <div className="mb-4">
        <div className="text-muted-foreground text-sm font-medium">{t("orgCliSessions.title")}</div>
        <p className="text-muted-foreground mt-1 max-w-prose text-xs">
          {t("orgCliSessions.description")}
        </p>
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          icon={Laptop}
          message={t("orgCliSessions.emptyTitle")}
          hint={t("orgCliSessions.emptyDescription")}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sessions.map((s) => {
            const Icon = deviceIcon(categorizeUserAgent(s.userAgent));
            const memberLabel = s.userName || s.userEmail || s.userId;
            return (
              <div
                key={s.familyId}
                className="border-border bg-card flex items-start gap-4 rounded-lg border p-5"
              >
                <Icon className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{deriveLabel(s, t)}</span>
                    <span className="text-muted-foreground text-xs">· {memberLabel}</span>
                  </div>
                  <div className="text-muted-foreground mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
                    {s.userAgent && (
                      <div className="truncate">
                        <span className="font-medium">{t("devices.userAgentLabel")}:</span>{" "}
                        <span className="font-mono">{s.userAgent}</span>
                      </div>
                    )}
                    {displayIp(s.createdIp) && (
                      <div>
                        <span className="font-medium">{t("devices.createdIpLabel")}:</span>{" "}
                        <span className="font-mono">{displayIp(s.createdIp)}</span>
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
                  disabled={revoke.isPending && revoke.variables === s.familyId}
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
        title={t("orgCliSessions.confirmRevokeTitle")}
        description={
          pendingRevoke
            ? t("orgCliSessions.confirmRevokeDescription", {
                device: deriveLabel(pendingRevoke, t),
                user: pendingRevoke.userName || pendingRevoke.userEmail || pendingRevoke.userId,
              })
            : ""
        }
        confirmLabel={t("devices.revoke")}
        variant="destructive"
        isPending={revoke.isPending}
        onConfirm={() => {
          if (!pendingRevoke) return;
          revoke.mutate(pendingRevoke.familyId, {
            onSuccess: () => setPendingRevoke(null),
          });
        }}
        onClose={() => setPendingRevoke(null)}
      />
    </>
  );
}
