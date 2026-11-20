// SPDX-License-Identifier: Apache-2.0

/** The access grants reaching the organization: members' MCP clients and CLI sessions. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { usePermissions } from "../../hooks/use-permissions";
import { ConfirmModal } from "../../components/confirm-modal";
import { AccessGrantSections } from "../../components/access-grant-sections";
import type { AccessGrantRow } from "../../components/access-grant-columns";
import { $api } from "../../api/client";
import { useOrg } from "../../hooks/use-org";
import { invalidatePaths } from "../../lib/query-keys";
import {
  grantHolderLabel,
  grantLabel,
  grantTargetLabel,
  type OrgAccessGrant,
} from "../../lib/access-grants";

export function OrgSettingsAccessGrantsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const { data, isLoading, error } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}/access-grants",
    { params: { path: { orgId: orgId ?? "" } } },
    {
      enabled: !!orgId,
      // Unwrap the list envelope — the universal 2xx list shape here.
      select: (envelope) => envelope.data,
    },
  );

  const revoke = $api.useMutation("delete", "/api/orgs/{orgId}/access-grants/{grantId}", {
    onSuccess: () => {
      void invalidatePaths(queryClient, ["/api/orgs/{orgId}/access-grants"]);
    },
  });

  const [pendingRevoke, setPendingRevoke] = useState<AccessGrantRow | null>(null);
  const pending = pendingRevoke as OrgAccessGrant | null;

  return (
    <>
      <div className="mb-4">
        <div className="text-muted-foreground text-sm font-medium">
          {t("orgAccessGrants.title")}
        </div>
        <p className="text-muted-foreground mt-1 max-w-prose text-xs">
          {t("orgAccessGrants.description")}
        </p>
      </div>

      <AccessGrantSections
        tableIdPrefix="access-grants-org"
        grants={data ?? []}
        // Without an org id the query never runs: an empty list is not an answer yet.
        isLoading={isLoading || !orgId}
        error={error}
        showHolder
        revokingId={revoke.isPending ? (revoke.variables?.params.path.grantId ?? null) : null}
        onRevoke={can("access-grants:delete") ? setPendingRevoke : undefined}
        emptyMcpHint={t("orgAccessGrants.mcpEmptyHint")}
        emptyCliHint={t("orgCliSessions.emptyDescription")}
      />

      <ConfirmModal
        open={pending !== null}
        title={t("accessGrants.confirmRevokeTitle")}
        description={
          pending
            ? pending.kind === "mcp"
              ? t("orgAccessGrants.confirmRevokeMcp", {
                  name: grantLabel(pending, t),
                  user: grantHolderLabel(pending),
                  target: grantTargetLabel(pending, t),
                })
              : t("orgCliSessions.confirmRevokeDescription", {
                  device: grantLabel(pending, t),
                  user: grantHolderLabel(pending),
                })
            : ""
        }
        confirmLabel={t("devices.revoke")}
        variant="destructive"
        isPending={revoke.isPending}
        onConfirm={() => {
          if (!pending) return;
          revoke.mutate(
            { params: { path: { orgId: orgId ?? "", grantId: pending.id } } },
            { onSuccess: () => setPendingRevoke(null) },
          );
        }}
        onClose={() => setPendingRevoke(null)}
      />
    </>
  );
}
