// SPDX-License-Identifier: Apache-2.0

/** The caller's own access grants: the MCP clients they authorized and their CLI sessions. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@appstrate/ui/components/button";
import { ConfirmModal } from "../../components/confirm-modal";
import { AccessGrantSections } from "../../components/access-grant-sections";
import type { AccessGrantRow } from "../../components/access-grant-columns";
import { $api } from "../../api/client";
import { invalidatePaths } from "../../lib/query-keys";
import { grantLabel, grantTargetPhrase } from "../../lib/access-grants";

const LIST_PATH = "/api/auth/access-grants";

export function PreferencesDevicesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = $api.useQuery(
    "get",
    LIST_PATH,
    {},
    // The endpoint answers `{ data: [...] }`; hand callers the array.
    { select: (envelope) => envelope.data },
  );

  const refresh = () => void invalidatePaths(queryClient, [LIST_PATH]);
  const revokeOne = $api.useMutation("post", "/api/auth/access-grants/revoke", {
    onSuccess: refresh,
  });
  const revokeAll = $api.useMutation("post", "/api/auth/access-grants/revoke-all", {
    onSuccess: refresh,
  });

  const [pendingRevoke, setPendingRevoke] = useState<AccessGrantRow | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const grants = data ?? [];

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="text-muted-foreground max-w-prose text-xs">{t("accessGrants.description")}</p>
        {grants.length > 1 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmRevokeAll(true)}
            disabled={revokeAll.isPending}
          >
            {t("accessGrants.revokeAll")}
          </Button>
        )}
      </div>

      <AccessGrantSections
        tableIdPrefix="access-grants-me"
        grants={grants}
        isLoading={isLoading}
        error={error}
        showHolder={false}
        revokingId={revokeOne.isPending ? (revokeOne.variables?.body.id ?? null) : null}
        onRevoke={setPendingRevoke}
        emptyMcpHint={t("accessGrants.mcpEmptyHint")}
        emptyCliHint={t("devices.emptyDescription")}
      />

      <ConfirmModal
        open={pendingRevoke !== null}
        title={t("accessGrants.confirmRevokeTitle")}
        description={
          pendingRevoke
            ? pendingRevoke.kind === "mcp"
              ? t("accessGrants.confirmRevokeMcp", {
                  name: grantLabel(pendingRevoke, t),
                  target: grantTargetPhrase(pendingRevoke, t),
                })
              : t("devices.confirmRevokeDescription", { name: grantLabel(pendingRevoke, t) })
            : ""
        }
        confirmLabel={t("devices.revoke")}
        variant="destructive"
        isPending={revokeOne.isPending}
        onConfirm={() => {
          if (!pendingRevoke) return;
          revokeOne.mutate(
            { body: { id: pendingRevoke.id } },
            { onSuccess: () => setPendingRevoke(null) },
          );
        }}
        onClose={() => setPendingRevoke(null)}
      />

      <ConfirmModal
        open={confirmRevokeAll}
        title={t("accessGrants.confirmRevokeAllTitle")}
        description={t("accessGrants.confirmRevokeAllDescription")}
        confirmLabel={t("accessGrants.revokeAll")}
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
