// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { usePermissions } from "../../hooks/use-permissions";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { EmptyState } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { ConfirmModal } from "../../components/confirm-modal";
import { $api } from "../../api/client";
import { useOrg } from "../../hooks/use-org";
import { deriveLabel } from "../../lib/cli-sessions";
import { invalidatePaths } from "../../lib/query-keys";
import {
  cliSessionUserLabel,
  useCliSessionColumns,
  type CliSessionRow,
} from "../../components/cli-session-columns";

export function OrgSettingsCliSessionsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const { data, isLoading, error } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}/cli-sessions",
    { params: { path: { orgId: orgId ?? "" } } },
    {
      enabled: !!orgId,
      // Unwrap the list envelope — the universal 2xx list shape here.
      select: (envelope) => envelope.data,
    },
  );

  const revoke = $api.useMutation("delete", "/api/orgs/{orgId}/cli-sessions/{familyId}", {
    onSuccess: () => {
      void invalidatePaths(queryClient, ["/api/orgs/{orgId}/cli-sessions"]);
    },
  });

  const [pendingRevoke, setPendingRevoke] = useState<CliSessionRow | null>(null);
  const columns = useCliSessionColumns({
    revokingFamilyId: revoke.isPending ? (revoke.variables?.params.path.familyId ?? null) : null,
    onRevoke: can("cli-sessions:delete") ? setPendingRevoke : undefined,
  });

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
        tableId="cli-sessions"
        columns={columns}
        rows={sessions}
        rowKey={(session) => session.familyId}
        label={t("orgCliSessions.tableLabel")}
        // Without an org id the query never runs: an empty list is not an answer yet.
        isLoading={isLoading || !orgId}
        failure={error}
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
                user: cliSessionUserLabel(pendingRevoke),
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
