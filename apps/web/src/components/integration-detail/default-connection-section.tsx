// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { IntegrationDetailWire } from "../../hooks/use-integrations";
import { connectionOptionLabel } from "../../lib/connection-set";
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

type DefaultConnectionDetail = Pick<IntegrationDetailWire, "auths" | "proxy_connection" | "active">;

/** The account a call without an agent uses in this space, or why there is none. */
function DefaultConnectionVerdict({ detail }: { detail: DefaultConnectionDetail }) {
  const { t } = useTranslation("settings");
  const verdict = detail.proxy_connection;
  const selected = detail.auths
    .flatMap((auth) => auth.connections)
    .find((c) => c.id === verdict.connection_id);
  const status = detail.active ? verdict.status : "inactive";
  const selectedKey = verdict.imposed
    ? "integration.defaultConnection.direct.imposedAccount"
    : "integration.defaultConnection.direct.account";
  return (
    <p className="text-sm" data-testid="default-connection-verdict">
      {status === "ready" && selected
        ? t(selectedKey, { account: connectionOptionLabel(selected) })
        : t(directCallLabels[status])}
    </p>
  );
}

/** Paramètres › Connexion par défaut: the space's default and the per-agent exceptions. */
export function DefaultConnectionSettings({
  packageId,
  detail,
}: {
  packageId: string;
  detail: DefaultConnectionDetail;
}) {
  const existingOnly = detail.auths.length === 0;
  return (
    <div className="flex flex-col gap-6" data-testid="default-connection-settings">
      <DefaultConnectionVerdict detail={detail} />
      <OrgDefaultSection packageId={packageId} existingOnly={existingOnly} />
      <PinManagementSection packageId={packageId} existingOnly={existingOnly} />
    </div>
  );
}
