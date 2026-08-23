// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Laptop } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { ConfirmModal } from "../../components/confirm-modal";
import { $api } from "../../api/client";
import { useOrg } from "../../hooks/use-org";
import { deriveLabel } from "../../lib/cli-sessions";
import { memberLabel, useCliSessionColumns, type AdminCliSession } from "./cli-session-columns";

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
      // Unwrap the list envelope (legacy apiList behavior).
      select: (envelope) => envelope.data,
    },
  );

  const revoke = $api.useMutation("delete", "/api/orgs/{orgId}/cli-sessions/{familyId}", {
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["get", "/api/orgs/{orgId}/cli-sessions"],
      });
    },
    onError: (mutationError) => toast.error(getErrorMessage(mutationError)),
  });

  const [pendingRevoke, setPendingRevoke] = useState<AdminCliSession | null>(null);
  const columns = useCliSessionColumns({
    revokingFamilyId: revoke.isPending ? (revoke.variables?.params.path.familyId ?? null) : null,
    onRevoke: setPendingRevoke,
  });

  // Not a request state: without an org id the query never runs, so `isLoading`
  // is false and the body would call an empty list an ANSWER. This waits for
  // context, which is what a spinner is for.
  if (!orgId) return <LoadingState />;

  const sessions = data ?? [];

  return (
    <>
      <div className="mb-4">
        <div className="text-muted-foreground text-sm font-medium">{t("orgCliSessions.title")}</div>
        <p className="text-muted-foreground mt-1 max-w-prose text-xs">
          {t("orgCliSessions.description")}
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={sessions}
        rowKey={(session) => session.familyId}
        label={t("orgCliSessions.tableLabel")}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={getErrorMessage(error)} compact />}
        empty={
          <EmptyState
            icon={Laptop}
            message={t("orgCliSessions.emptyTitle")}
            hint={t("orgCliSessions.emptyDescription")}
          />
        }
      />

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
