// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";
import { CliSessionCard } from "../../components/cli-session-card";
import { $api } from "../../api/client";
import { deriveLabel, type CliSessionDisplay } from "../../lib/cli-sessions";

const SESSIONS_QUERY_KEY = ["get", "/api/auth/cli/sessions"] as const;

export function PreferencesDevicesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = $api.useQuery(
    "get",
    "/api/auth/cli/sessions",
    {},
    {
      // Unwrap the list envelope (legacy apiFetch behavior).
      select: (envelope) => envelope.data,
    },
  );

  const revokeOne = $api.useMutation("post", "/api/auth/cli/sessions/revoke", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  const revokeAll = $api.useMutation("post", "/api/auth/cli/sessions/revoke-all", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  const [pendingRevoke, setPendingRevoke] = useState<CliSessionDisplay | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

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

      {sessions.length === 0 ? (
        <EmptyState
          icon={Laptop}
          message={t("devices.emptyTitle")}
          hint={t("devices.emptyDescription")}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sessions.map((s) => (
            <CliSessionCard
              key={s.familyId}
              session={s}
              revokeDisabled={
                revokeOne.isPending && revokeOne.variables?.body.familyId === s.familyId
              }
              onRevoke={() => setPendingRevoke(s)}
            />
          ))}
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
