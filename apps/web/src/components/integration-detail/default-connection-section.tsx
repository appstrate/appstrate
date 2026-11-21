// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { IntegrationDetailWire } from "../../hooks/use-integrations";
import { connectionOptionLabel } from "../../lib/connection-set";
import { SettingsHeading } from "../settings/settings-heading";
import { OrgDefaultSection } from "./org-default-section";
import { PinManagementSection } from "./pin-management-section";

const directCallLabels = {
  ready: "integration.defaultConnection.direct.ready",
  must_choose: "integration.defaultConnection.direct.must_choose",
  needs_reconnection: "integration.defaultConnection.direct.needs_reconnection",
  none: "integration.defaultConnection.direct.none",
  not_permitted: "integration.defaultConnection.direct.not_permitted",
  default_unavailable: "integration.defaultConnection.direct.default_unavailable",
  unusable: "integration.defaultConnection.direct.unusable",
  proxy_closed: "integration.defaultConnection.direct.proxy_closed",
  not_required: "integration.defaultConnection.direct.not_required",
  not_published: "integration.defaultConnection.direct.not_published",
  inactive: "integration.defaultConnection.direct.inactive",
} as const satisfies Record<
  IntegrationDetailWire["proxy_connection"]["status"] | "inactive",
  string
>;

export function DefaultConnectionSection({
  packageId,
  detail,
  canConfigure,
}: {
  packageId: string;
  detail: Pick<IntegrationDetailWire, "auths" | "proxy_connection" | "active">;
  canConfigure: boolean;
}) {
  const { t } = useTranslation("settings");
  const verdict = detail.proxy_connection;
  const selected = detail.auths
    .flatMap((auth) => auth.connections)
    .find((c) => c.id === verdict.connection_id);
  const status = detail.active ? verdict.status : "inactive";
  const selectedKey = verdict.imposed
    ? "integration.defaultConnection.direct.imposedAccount"
    : "integration.defaultConnection.direct.account";
  const existingOnly = detail.auths.length === 0;
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
      <p className="text-sm">
        {status === "ready" && selected
          ? t(selectedKey, { account: connectionOptionLabel(selected) })
          : t(directCallLabels[status])}
      </p>
      {canConfigure && (
        <>
          <OrgDefaultSection packageId={packageId} existingOnly={existingOnly} />
          <PinManagementSection packageId={packageId} existingOnly={existingOnly} />
        </>
      )}
    </section>
  );
}
