// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import type { useMemberDepartureImpact } from "../../hooks/use-org";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { SkeletonLine } from "../../components/skeleton-line";
import { ErrorState } from "../../components/page-states";
import { scheduleLabel } from "../../lib/schedule-options";
import {
  departureFixHref,
  departureFixSection,
  type DepartureImpactItem,
} from "../../lib/member-departure";

function causeLabel(t: TFunction, cause: DepartureImpactItem["cause"]): string {
  return cause === "actor_left_org"
    ? t("orgSettings.departure.causeActorLeft")
    : t("orgSettings.departure.causeConnectionUnshared");
}

/**
 * What removing a member would stop in team spaces, inside the removal confirmation. It informs
 * and never blocks: a failed read leaves the removal open.
 */
export function MemberDepartureImpact({
  impact,
}: {
  impact: Pick<ReturnType<typeof useMemberDepartureImpact>, "data" | "isLoading" | "error">;
}) {
  const { t } = useTranslation(["settings", "agents"]);
  const currentSpaceId = useCurrentSpaceId();

  if (impact.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <SkeletonLine className="w-1/2 text-sm font-medium" />
        <div className="divide-y rounded-md border">
          {[0, 1].map((row) => (
            <div key={row} className="flex flex-col gap-1 px-3 py-2">
              <SkeletonLine className="w-2/3 text-sm font-medium" />
              <SkeletonLine className="w-1/3 text-xs" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (impact.error) return <ErrorState error={impact.error} compact />;
  const items = impact.data;
  if (!items) return null;
  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("orgSettings.departure.none")}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{t("orgSettings.departure.title")}</p>
      <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{scheduleLabel(item, t)}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {item.space.name}
                  {item.actor.name ? ` · ${item.actor.name}` : ""}
                </p>
              </div>
              <Link
                to={departureFixHref(item, currentSpaceId)}
                className="text-primary shrink-0 text-xs font-medium hover:underline"
              >
                {departureFixSection(item) === "identity"
                  ? t("orgSettings.departure.reassign")
                  : t("orgSettings.departure.chooseConnection")}
              </Link>
            </div>
            <p className="text-muted-foreground text-xs">{causeLabel(t, item.cause)}</p>
            {item.lost_integrations.length > 0 && (
              <Alert variant="warning" size="sm">
                <AlertDescription>
                  {t("orgSettings.departure.replacementRequired", {
                    integrations: item.lost_integrations.join(", "),
                  })}
                </AlertDescription>
              </Alert>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
