// SPDX-License-Identifier: Apache-2.0

/** The access grants reaching the organization: members' MCP clients and CLI sessions. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { usePermissions } from "../../hooks/use-permissions";
import { ConfirmModal } from "../../components/confirm-modal";
import { AccessGrantSections } from "../../components/access-grant-sections";
import { $api } from "../../api/client";
import { useOrg } from "../../hooks/use-org";
import { invalidatePaths } from "../../lib/query-keys";
import {
  ACCESS_GRANT_PATHS,
  grantHolderLabel,
  grantLabel,
  grantTargetPhrase,
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
    { enabled: !!orgId, select: (envelope) => envelope.data },
  );

  const revoke = $api.useMutation("delete", "/api/orgs/{orgId}/access-grants/{grantId}", {
    onSuccess: () => void invalidatePaths(queryClient, [...ACCESS_GRANT_PATHS]),
  });

  const [pending, setPending] = useState<OrgAccessGrant | null>(null);

  return (
    <>
      <p className="text-muted-foreground mb-6 max-w-2xl text-sm leading-relaxed">
        {t("orgAccessGrants.description")}
      </p>

      <AccessGrantSections
        tableIdPrefix="access-grants-org"
        grants={data ?? []}
        // Without an org id the query never runs: an empty list is not an answer yet.
        isLoading={isLoading || !orgId}
        error={error}
        showHolder
        revokingId={revoke.isPending ? (revoke.variables?.params.path.grantId ?? null) : null}
        onRevoke={can("access-grants:delete") ? setPending : undefined}
        emptyMcpHint={t("orgAccessGrants.mcpEmptyHint")}
        emptyCliHint={t("orgAccessGrants.cliEmptyHint")}
      />

      <ConfirmModal
        open={pending !== null}
        title={t("accessGrants.confirmRevokeTitle")}
        description={
          !pending
            ? ""
            : pending.target
              ? t("orgAccessGrants.confirmRevokeMcp", {
                  name: grantLabel(pending, t),
                  user: grantHolderLabel(pending),
                  target: grantTargetPhrase(pending.target, t),
                })
              : t("orgAccessGrants.confirmRevokeCli", {
                  device: grantLabel(pending, t),
                  user: grantHolderLabel(pending),
                })
        }
        confirmLabel={t("devices.revoke")}
        variant="destructive"
        isPending={revoke.isPending}
        onConfirm={() => {
          if (!pending) return;
          revoke.mutate(
            { params: { path: { orgId: orgId ?? "", grantId: pending.id } } },
            { onSuccess: () => setPending(null) },
          );
        }}
        onClose={() => setPending(null)}
      />
    </>
  );
}
