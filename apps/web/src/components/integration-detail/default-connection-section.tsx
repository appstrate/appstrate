// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { IntegrationDetailWire } from "../../hooks/use-integrations";
import { connectionOptionLabel } from "../../lib/connection-set";

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

/**
 * One line under the Connexions table, for every reader: the account a call naming none uses in
 * this space (`proxy_connection`), or why there is none. A configurer gets the way to
 * Paramètres › Gestion des connexions (`editHref`), where the default and the exceptions are set.
 */
export function DefaultConnectionLine({
  detail,
  editHref,
}: {
  detail: DefaultConnectionDetail;
  editHref?: string;
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
  return (
    <p
      className="text-muted-foreground mt-4 flex flex-wrap items-baseline gap-x-2 text-sm"
      data-testid="default-connection-verdict"
    >
      <span>
        {status === "ready" && selected
          ? t(selectedKey, { account: connectionOptionLabel(selected) })
          : t(directCallLabels[status])}
      </span>
      {editHref && (
        <Link
          to={editHref}
          className="text-primary hover:underline"
          data-testid="default-connection-edit"
        >
          {t("integration.defaultConnection.edit")}
        </Link>
      )}
    </p>
  );
}
