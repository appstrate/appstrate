// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { EmptyState } from "../../components/page-states";
import { DataTable } from "../../components/data-table";
import { ConfirmModal } from "../../components/confirm-modal";
import { useCliSessionColumns } from "../../components/cli-session-columns";
import { $api } from "../../api/client";
import { invalidatePaths } from "../../lib/query-keys";
import { deriveLabel, type CliSessionDisplay } from "../../lib/cli-sessions";

export function PreferencesDevicesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = $api.useQuery(
    "get",
    "/api/auth/cli/sessions",
    {},
    {
      // The endpoint answers `{ data: [...] }`; hand callers the array.
      select: (envelope) => envelope.data,
    },
  );

  const revokeOne = $api.useMutation("post", "/api/auth/cli/sessions/revoke", {
    onSuccess: () => {
      void invalidatePaths(queryClient, ["/api/auth/cli/sessions"]);
    },
  });

  const revokeAll = $api.useMutation("post", "/api/auth/cli/sessions/revoke-all", {
    onSuccess: () => {
      void invalidatePaths(queryClient, ["/api/auth/cli/sessions"]);
    },
  });

  const [pendingRevoke, setPendingRevoke] = useState<CliSessionDisplay | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  const columns = useCliSessionColumns({
    showMember: false,
    revokingFamilyId: revokeOne.isPending ? (revokeOne.variables?.body.familyId ?? null) : null,
    onRevoke: setPendingRevoke,
  });

  const sessions = data ?? [];

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

      <DataTable
        columns={columns}
        rows={sessions}
        rowKey={(s) => s.familyId}
        label={t("devices.title")}
        isLoading={isLoading}
        failure={error}
        empty={
          <EmptyState
            icon={Laptop}
            message={t("devices.emptyTitle")}
            hint={t("devices.emptyDescription")}
          />
        }
      />

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
          revokeOne.mutate(
            { body: { familyId: pendingRevoke.familyId } },
            { onSuccess: () => setPendingRevoke(null) },
          );
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
          revokeAll.mutate({}, { onSuccess: () => setConfirmRevokeAll(false) });
        }}
        onClose={() => setConfirmRevokeAll(false)}
      />
    </>
  );
}
