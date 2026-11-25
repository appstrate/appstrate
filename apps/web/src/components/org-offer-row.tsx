// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@appstrate/ui/components/switch";
import { cn } from "@appstrate/ui/cn";
import { useSetOrgOffer } from "../hooks/use-library";
import { ConfirmModal } from "./confirm-modal";

/** Same box for the two rows. */
const ROW_CLASS =
  "border-border flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm";

/** The row's markup: the package's offer to the organization and its switch. */
function OrgOfferSwitchRow({
  name,
  offered,
  pending,
  onToggle,
  className,
}: {
  name: string;
  className?: string;
  offered: boolean;
  pending: boolean;
  /** `undefined`: the reader may see the offer, not change it. */
  onToggle: ((next: boolean) => void) | undefined;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className={cn(ROW_CLASS, className)}>
      <div className="min-w-0">
        <p className="font-medium">{t("catalogue.orgOffer.label")}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{t("catalogue.orgOffer.help")}</p>
      </div>
      <Switch
        checked={offered}
        disabled={pending || !onToggle}
        aria-label={t("catalogue.orgOffer.switch", { package: name })}
        onCheckedChange={(next) => onToggle?.(next === true)}
      />
    </div>
  );
}

/**
 * Offers a package to the whole organization, or withdraws it. A package the deployment already
 * activates everywhere takes no offer: a plain row says so. Shown to a reader who may change
 * the offer (`org_offerable`) and, read-only, to anyone else when it stands. Withdrawing asks
 * first: every space without a row of its own stops running it and loses its schedules.
 */
export function OrgOfferRow({
  item,
  className,
}: {
  item: {
    id: string;
    name: string;
    offered_to_org: boolean;
    org_offerable: boolean;
    active_by_default: boolean;
  };
  className?: string;
}) {
  const { t } = useTranslation("settings");
  const setOffer = useSetOrgOffer();
  const [confirming, setConfirming] = useState(false);
  if (item.active_by_default && !item.offered_to_org) {
    return (
      <div className={cn(ROW_CLASS, className)}>
        <div className="min-w-0">
          <p className="font-medium">{t("catalogue.orgOffer.defaultActive")}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t("catalogue.orgOffer.defaultActiveHelp")}
          </p>
        </div>
      </div>
    );
  }
  if (!item.offered_to_org && !item.org_offerable) return null;
  const name = item.name || item.id;
  return (
    <>
      <OrgOfferSwitchRow
        name={name}
        offered={item.offered_to_org}
        pending={setOffer.isPending}
        className={className}
        onToggle={
          item.org_offerable
            ? (next) =>
                next ? setOffer.mutate({ packageId: item.id, offered: true }) : setConfirming(true)
            : undefined
        }
      />
      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("catalogue.orgOffer.withdrawTitle")}
        description={t("catalogue.orgOffer.withdrawConfirm", { name })}
        confirmLabel={t("catalogue.orgOffer.withdrawAction")}
        isPending={setOffer.isPending}
        onConfirm={() =>
          setOffer.mutate(
            { packageId: item.id, offered: false },
            { onSuccess: () => setConfirming(false) },
          )
        }
      />
    </>
  );
}
