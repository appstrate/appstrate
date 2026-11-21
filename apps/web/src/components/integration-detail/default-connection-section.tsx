// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { SettingsHeading } from "../settings/settings-heading";
import { OrgDefaultSection } from "./org-default-section";
import { PinManagementSection } from "./pin-management-section";

/**
 * What runs use when no one picks a connection: the space's default, then the per-agent
 * exceptions. The tab's h2, anchored for the lock hints.
 */
export function DefaultConnectionSection({ packageId }: { packageId: string }) {
  const { t } = useTranslation("settings");
  return (
    <section
      id="default-connection"
      className="mt-8 flex flex-col gap-6"
      data-testid="default-connection"
    >
      <SettingsHeading
        className="mb-0"
        title={t("integration.defaultConnection.title")}
        description={t("integration.defaultConnection.description")}
      />
      <OrgDefaultSection packageId={packageId} />
      <PinManagementSection packageId={packageId} />
    </section>
  );
}
