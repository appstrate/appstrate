// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { OptionSelect } from "@appstrate/ui/components/select";
import { SettingsHeading } from "../settings/settings-heading";
import { SaveFeedback } from "../settings/save-feedback";
import { useUpdateIntegrationSettings } from "../../hooks/use-integrations";
import { OrgDefaultSection } from "./org-default-section";
import { PinManagementSection } from "./pin-management-section";

/**
 * Who may create connections, the space default and the per-agent exceptions:
 * cross-cutting, not tied to one auth, and admin only.
 */
export function AccessRulesSection({
  packageId,
  blockUserConnections,
}: {
  packageId: string;
  blockUserConnections: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-8" data-testid="access-rules-section">
      <section>
        <SettingsHeading level="group" title={t("integration.admin.accounts.title")} />
        <BlockUserConnectionsToggle packageId={packageId} initialBlocked={blockUserConnections} />
        <OrgDefaultSection packageId={packageId} />
      </section>
      <PinManagementSection packageId={packageId} />
    </div>
  );
}

function BlockUserConnectionsToggle({
  packageId,
  initialBlocked,
}: {
  packageId: string;
  initialBlocked: boolean;
}) {
  const { t } = useTranslation("settings");
  const updateSettings = useUpdateIntegrationSettings();
  // Drives the control from server state. A pending mutation reads the
  // about-to-be-applied value, idle reads the latest fetched value.
  const blocked =
    updateSettings.isPending && updateSettings.variables?.params.path.packageId === packageId
      ? updateSettings.variables.body.block_user_connections
      : initialBlocked;
  return (
    <div className="grid gap-6 pb-8 md:grid-cols-2" data-testid="block-user-connections-section">
      <div className="min-w-0">
        <p id="account-creation-label" className="mb-3 text-sm font-medium">
          {t("integration.admin.creation.title")}
        </p>
        <OptionSelect
          value={blocked ? "admins" : "members"}
          disabled={updateSettings.isPending}
          onValueChange={(value) =>
            updateSettings.mutate({
              params: { path: { packageId } },
              body: { block_user_connections: value === "admins" },
            })
          }
          aria-labelledby="account-creation-label"
          data-testid="block-user-connections-toggle"
          options={(["admins", "members"] as const).map((value) => ({
            value,
            label: t(`integration.admin.creation.${value}`),
          }))}
        />
        <div className="mt-1.5">
          <SaveFeedback
            pending={updateSettings.isPending}
            success={updateSettings.isSuccess}
            error={updateSettings.isError}
          />
        </div>
      </div>
    </div>
  );
}
