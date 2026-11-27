// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { useSetOrgOffer, type OrgOfferMode } from "../hooks/use-library";
import { offerChangeStep, type OfferChoice } from "../lib/org-offer-change";
import { OptionSelect } from "./app-ui/option-select";
import { ConfirmModal } from "./confirm-modal";
import { OrgOfferClosureDialog } from "./org-offer-closure-dialog";
import type { OfferWarning } from "../lib/org-offer-closure";

/** Same box for the two rows. */
const ROW_CLASS =
  "border-border flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm";

/**
 * The row's markup: the package's offer to the organization and the choice of its mode.
 * `onChange` is `undefined` when the reader may see the offer, not change it.
 */
function OrgOfferChoiceRow({
  name,
  choice,
  pending,
  onChange,
  className,
}: {
  name: string;
  className?: string;
  choice: OfferChoice;
  pending: boolean;
  onChange: ((next: OfferChoice) => void) | undefined;
}) {
  const { t } = useTranslation("settings");
  const labels: Record<OfferChoice, string> = {
    none: t("catalogue.orgOffer.modeNone"),
    available: t("catalogue.orgOffer.modeAvailable"),
    on_by_default: t("catalogue.orgOffer.modeOnByDefault"),
  };
  const help =
    choice === "available"
      ? t("catalogue.orgOffer.helpAvailable")
      : choice === "on_by_default"
        ? t("catalogue.orgOffer.helpOnByDefault")
        : t("catalogue.orgOffer.helpNone");
  return (
    <div className={cn(ROW_CLASS, className)}>
      <div className="min-w-0">
        <p className="font-medium">{t("catalogue.orgOffer.label")}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{help}</p>
      </div>
      {onChange ? (
        <OptionSelect
          value={choice}
          onValueChange={(next) => onChange(next as OfferChoice)}
          disabled={pending}
          aria-label={t("catalogue.orgOffer.switch", { package: name })}
          className="w-56 shrink-0"
          options={(["none", "available", "on_by_default"] as const).map((value) => ({
            value,
            label: labels[value],
          }))}
        />
      ) : (
        <span className="shrink-0 font-medium">{labels[choice]}</span>
      )}
    </div>
  );
}

/**
 * Offers a package to the whole organization, in one of two modes, or withdraws the offer. A
 * package the deployment already activates everywhere takes no offer: a plain row says so. Shown
 * to a reader who may change the offer (`org_offerable`) and, read-only, to anyone else when it
 * stands. Withdrawing or downgrading asks first (see `offerChangeStep`).
 */
export function OrgOfferRow({
  item,
  className,
}: {
  item: {
    id: string;
    name: string;
    org_offer: OrgOfferMode | null;
    org_offerable: boolean;
    active_by_default: boolean;
  };
  className?: string;
}) {
  const { t } = useTranslation("settings");
  const setOffer = useSetOrgOffer();
  const [pendingChoice, setPendingChoice] = useState<"none" | "available" | null>(null);
  const [closure, setClosure] = useState<{
    mode: OrgOfferMode;
    warnings: OfferWarning[];
  } | null>(null);
  const offerIn = (mode: OrgOfferMode, onDone?: () => void) =>
    setOffer.mutate(
      { packageId: item.id, mode },
      {
        onSuccess: (warnings) => {
          if (warnings && warnings.length > 0) setClosure({ mode, warnings });
          onDone?.();
        },
      },
    );
  if (item.active_by_default && !item.org_offer) {
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
  if (!item.org_offer && !item.org_offerable) return null;
  const name = item.name || item.id;
  const choice: OfferChoice = item.org_offer ?? "none";
  const change = (next: OfferChoice) => {
    const step = offerChangeStep(choice, next);
    if (step === "confirm_withdraw") setPendingChoice("none");
    else if (step === "confirm_available") setPendingChoice("available");
    else if (step === "apply" && next !== "none") offerIn(next);
  };
  return (
    <>
      <OrgOfferChoiceRow
        name={name}
        choice={choice}
        pending={setOffer.isPending}
        className={className}
        onChange={item.org_offerable ? change : undefined}
      />
      <ConfirmModal
        open={pendingChoice === "none"}
        onClose={() => setPendingChoice(null)}
        title={t("catalogue.orgOffer.withdrawTitle")}
        description={t("catalogue.orgOffer.withdrawConfirm", { name })}
        confirmLabel={t("catalogue.orgOffer.withdrawAction")}
        isPending={setOffer.isPending}
        onConfirm={() =>
          setOffer.mutate(
            { packageId: item.id, mode: null },
            { onSuccess: () => setPendingChoice(null) },
          )
        }
      />
      <ConfirmModal
        open={pendingChoice === "available"}
        onClose={() => setPendingChoice(null)}
        title={t("catalogue.orgOffer.availableTitle")}
        description={t("catalogue.orgOffer.availableConfirm")}
        confirmLabel={t("catalogue.orgOffer.availableAction")}
        isPending={setOffer.isPending}
        onConfirm={() => offerIn("available", () => setPendingChoice(null))}
      />
      {closure && (
        <OrgOfferClosureDialog
          warnings={closure.warnings}
          mode={closure.mode}
          onClose={() => setClosure(null)}
        />
      )}
    </>
  );
}
