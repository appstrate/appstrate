// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AddIntegrationConnection } from "../integration-connect/add-integration-connection";
import { connectableAuthKeys } from "../integration-connect/connectable-auth-keys";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { RoleLimitNotice } from "../role-limit-notice";
import { connectBlocker, type ConnectBlocker } from "../../lib/integration-wizard";
import { useAuth } from "../../hooks/use-auth";
import { usePermissions } from "../../hooks/use-permissions";
import type { IntegrationDetailWire } from "../../hooks/use-integrations";
import { packageDetailPath } from "../../lib/package-paths";
import { integrationSettingsHref } from "../../lib/settings-section-href";
import { WizardSection } from "./wizard-section";

const BLOCKER_KEY: Record<Exclude<ConnectBlocker, "none">, string> = {
  reconnect: "integrationWizard.connect.blocker.reconnect",
  reconnectImposed: "integrationWizard.connect.blocker.reconnectImposed",
  notPermitted: "integrationWizard.connect.blocker.notPermitted",
  defaultUnavailable: "integrationWizard.connect.blocker.defaultUnavailable",
  unusable: "integrationWizard.connect.blocker.unusable",
  unusableImposed: "integrationWizard.connect.blocker.unusableImposed",
};

/**
 * Connecting an account, through the integration's own connect flow, or the blocker the space's
 * governance puts in the way (`proxy_connection`). The page moves on by itself once the verdict
 * lets a call through.
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
  const { blocker, offerConnect } = connectBlocker(detail.proxy_connection);
  return (
    <WizardSection
      title={t("integrationWizard.connect.title")}
      description={t("integrationWizard.connect.description")}
    >
      {blocker !== "none" && (
        <Alert variant="warning" data-testid="integration-wizard-connect-blocker">
          <AlertDescription>{t(BLOCKER_KEY[blocker])}</AlertDescription>
        </Alert>
      )}
      {!offerConnect ? null : !canConnect ? (
        <RoleLimitNotice>{t("integrationWizard.connect.noPermission")}</RoleLimitNotice>
      ) : clientMissing && !canConfigure ? (
        <RoleLimitNotice>{t("integrationWizard.connect.clientMissing")}</RoleLimitNotice>
      ) : null}
      {offerConnect && (canConnect || canConfigure) && (
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
