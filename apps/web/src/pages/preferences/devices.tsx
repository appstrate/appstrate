// SPDX-License-Identifier: Apache-2.0

/** The caller's own access grants: the MCP clients they authorized and their CLI sessions. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { ConfirmModal } from "../../components/confirm-modal";
import { AccessGrantSections } from "../../components/access-grant-sections";
import { SettingsPageActions } from "../../components/settings/settings-page-actions";
import { $api } from "../../api/client";
import { invalidatePaths } from "../../lib/query-keys";
import {
  ACCESS_GRANT_PATHS,
  grantLabel,
  grantTargetPhrase,
  type AccessGrant,
} from "../../lib/access-grants";

export function PreferencesDevicesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = $api.useQuery(
    "get",
    "/api/auth/access-grants",
    {},
    { select: (envelope) => envelope.data },
  );

  const refresh = () => void invalidatePaths(queryClient, [...ACCESS_GRANT_PATHS]);
  const revokeOne = $api.useMutation("post", "/api/auth/access-grants/revoke", {
    onSuccess: refresh,
  });
  const revokeAll = $api.useMutation("post", "/api/auth/access-grants/revoke-all", {
    onSuccess: refresh,
  });

  const [pendingRevoke, setPendingRevoke] = useState<AccessGrant | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const grants = data ?? [];

  return (
    <>
      <SettingsPageActions
        actions={[
          {
            id: "revoke-all",
            label: t("accessGrants.revokeAll"),
            icon: Trash2,
            onSelect: () => setConfirmRevokeAll(true),
            disabled: revokeAll.isPending,
            destructive: true,
            hidden: grants.length < 2,
          },
        ]}
      />
      <p className="text-muted-foreground mb-6 max-w-2xl text-sm leading-relaxed">
        {t("accessGrants.description")}
      </p>

      <AccessGrantSections
        tableIdPrefix="access-grants-me"
        grants={grants}
        isLoading={isLoading}
        error={error}
        showHolder={false}
        revokingId={revokeOne.isPending ? (revokeOne.variables?.body.id ?? null) : null}
        onRevoke={setPendingRevoke}
        emptyMcpHint={t("accessGrants.mcpEmptyHint")}
        emptyCliHint={t("accessGrants.cliEmptyHint")}
      />

      <ConfirmModal
        open={pendingRevoke !== null}
        title={t("accessGrants.confirmRevokeTitle")}
        description={
          !pendingRevoke
            ? ""
            : pendingRevoke.target
              ? t("accessGrants.confirmRevokeMcp", {
                  name: grantLabel(pendingRevoke, t),
                  target: grantTargetPhrase(pendingRevoke.target, t),
                })
              : t("accessGrants.confirmRevokeCli", { name: grantLabel(pendingRevoke, t) })
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
