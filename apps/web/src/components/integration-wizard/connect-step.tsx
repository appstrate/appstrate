// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AddIntegrationConnection } from "../integration-connect/add-integration-connection";
import { connectableAuthKeys } from "../integration-connect/connectable-auth-keys";
import { RoleLimitNotice } from "../role-limit-notice";
import { useAuth } from "../../hooks/use-auth";
import { usePermissions } from "../../hooks/use-permissions";
import type { IntegrationDetailWire } from "../../hooks/use-integrations";
import { packageDetailPath } from "../../lib/package-paths";
import { integrationSettingsHref } from "../../lib/settings-section-href";
import { WizardSection } from "./wizard-section";

/**
 * Connecting an account, through the integration's own connect flow. The page moves on by
 * itself once the detail lists a usable connection.
 */
export function ConnectStep({
  packageId,
  detail,
}: {
  packageId: string;
  detail: IntegrationDetailWire;
}) {
  const { t } = useTranslation("agents");
  const navigate = useNavigate();
  const { user } = useAuth();
  const { can } = usePermissions();
  const canConnect = can("integrations:connect");
  const canConfigure = can("integrations:configure");
  const clientMissing = connectableAuthKeys(detail.manifest, detail.auths).size === 0;
  return (
    <WizardSection
      title={t("integrationWizard.connect.title")}
      description={t("integrationWizard.connect.description")}
    >
      {!canConnect ? (
        <RoleLimitNotice>{t("integrationWizard.connect.noPermission")}</RoleLimitNotice>
      ) : clientMissing && !canConfigure ? (
        <RoleLimitNotice>{t("integrationWizard.connect.clientMissing")}</RoleLimitNotice>
      ) : null}
      {(canConnect || canConfigure) && (
        // The add button's label shows from the `bar` container's `sm` width.
        <div className="@container/bar">
          <AddIntegrationConnection
            packageId={packageId}
            detail={detail}
            userId={user?.id}
            canConnect={canConnect}
            canConfigure={canConfigure}
            onConfigure={() =>
              navigate(
                integrationSettingsHref(
                  packageDetailPath("integration", packageId),
                  "authentication",
                ),
              )
            }
            blockedReason={
              detail.block_user_connections && !canConfigure
                ? t("integration.auth.blockedByAdminHint", { ns: "settings" })
                : undefined
            }
          />
        </div>
      )}
      <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
        {t("integrationWizard.connect.waiting")}
      </p>
    </WizardSection>
  );
}
