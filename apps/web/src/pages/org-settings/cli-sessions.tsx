// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";
import { CliSessionCard } from "../../components/cli-session-card";
import { $api } from "../../api/client";
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

  const { data, isLoading, error } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}/cli-sessions",
    { params: { path: { orgId: orgId ?? "" } } },
    {
      enabled: !!orgId,
      // Unwrap the list envelope (legacy apiList behavior). The spec declares
      // the item fields optional, but the route always serializes them.
      select: (envelope) => envelope.data as AdminCliSession[],
    },
  );

  const revoke = $api.useMutation("delete", "/api/orgs/{orgId}/cli-sessions/{familyId}", {
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["get", "/api/orgs/{orgId}/cli-sessions"],
      });
    },
  });

  const [pendingRevoke, setPendingRevoke] = useState<AdminCliSession | null>(null);

  if (!orgId) return <LoadingState />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

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
              revokeDisabled={
                revoke.isPending && revoke.variables?.params.path.familyId === s.familyId
              }
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
          revoke.mutate(
            { params: { path: { orgId: orgId ?? "", familyId: pendingRevoke.familyId } } },
            { onSuccess: () => setPendingRevoke(null) },
          );
        }}
        onClose={() => setPendingRevoke(null)}
      />
    </>
  );
}
