// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";
import { CliSessionCard } from "../../components/cli-session-card";
import { api, apiList } from "../../api";
import { useOrg } from "../../hooks/use-org";
import { deriveLabel, type CliSessionDisplay } from "../../lib/cli-sessions";

interface AdminCliSession extends CliSessionDisplay {
  userId: string;
  userEmail: string | null;
  userName: string | null;
}

function memberLabel(s: AdminCliSession): string {
  return s.userName || s.userEmail || s.userId;
}

export function OrgSettingsCliSessionsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const { data, isLoading, error } = useQuery({
    queryKey: ["org-cli-sessions", orgId],
    queryFn: () => apiList<AdminCliSession>(`/orgs/${orgId}/cli-sessions`),
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

  const sessions = data ?? [];

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
          {sessions.map((s) => (
            <CliSessionCard
              key={s.familyId}
              session={s}
              meta={<span className="text-muted-foreground text-xs">· {memberLabel(s)}</span>}
              revokeDisabled={revoke.isPending && revoke.variables === s.familyId}
              onRevoke={() => setPendingRevoke(s)}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        open={pendingRevoke !== null}
        title={t("orgCliSessions.confirmRevokeTitle")}
        description={
          pendingRevoke
            ? t("orgCliSessions.confirmRevokeDescription", {
                device: deriveLabel(pendingRevoke, t),
                user: memberLabel(pendingRevoke),
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
