// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Share2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import type { PackageType } from "@appstrate/core/validation";
import type { PackageAvailability } from "@appstrate/shared-types";
import { availabilityLabel } from "../../lib/package-availability";
import { DetailSectionCard } from "../detail-section-card";
import { OperationalStat } from "../operational-stat";
import { OrgOfferRow } from "../org-offer-row";
import { SkeletonLine } from "../skeleton-line";
import { useCatalogueEntry } from "./catalogue-link";

/**
 * Whether the working space runs the package and how it got there, then what the reader may do
 * about the organization offer and the sharing into other spaces (the catalogue's sheet). One card
 * for every package type; activation itself stays the page's own control.
 */
export function AvailabilityCard({
  type,
  packageId,
  name,
  availability,
}: {
  type: PackageType;
  packageId: string;
  name: string;
  availability: PackageAvailability;
}) {
  const { t } = useTranslation("settings");
  const catalogue = useCatalogueEntry(type, packageId);
  const { key, params } = availabilityLabel(availability, type);
  const { offered_to_org, org_offerable, active_by_default } = availability;
  return (
    <DetailSectionCard title={t("packages.availability.title")} icon={Share2} bodyClassName="p-0">
      <dl className="divide-y">
        <OperationalStat label={t("packages.availability.here")} value={t(key, params)} size="sm" />
      </dl>
      {(offered_to_org || org_offerable || active_by_default || catalogue) && (
        <div className="flex flex-col gap-3 border-t p-4">
          <OrgOfferRow
            item={{ id: packageId, name, offered_to_org, org_offerable, active_by_default }}
          />
          {catalogue && (
            <Link
              to={catalogue.to}
              state={catalogue.state}
              className="text-primary w-fit text-sm font-medium hover:underline"
            >
              {catalogue.label}
            </Link>
          )}
        </div>
      )}
    </DetailSectionCard>
  );
}

/**
 * The header pill of a package page: the same sentence as the card's « Dans cet espace » row,
 * green when the working space runs the package. The page leaves it out in « Tous les espaces »,
 * where the spaces it is active in say it.
 */
export function AvailabilityBadge({
  type,
  availability,
}: {
  type: PackageType;
  availability: PackageAvailability;
}) {
  const { t } = useTranslation("settings");
  const { key, params } = availabilityLabel(availability, type);
  return (
    <Badge variant={availability.state === "active" ? "success" : "warning"} className="shrink-0">
      {t(key, params)}
    </Badge>
  );
}

/** {@link AvailabilityCard} while its page loads: the title and the « Dans cet espace » row. */
export function AvailabilityCardSkeleton() {
  const { t } = useTranslation("settings");
  return (
    <DetailSectionCard title={t("packages.availability.title")} icon={Share2} bodyClassName="p-0">
      <dl className="divide-y">
        <OperationalStat
          label={t("packages.availability.here")}
          value={<SkeletonLine className="w-40 text-sm" />}
          size="sm"
        />
      </dl>
    </DetailSectionCard>
  );
}
