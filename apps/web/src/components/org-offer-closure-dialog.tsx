// SPDX-License-Identifier: Apache-2.0

/**
 * Offering an agent to the organization names the integrations it declares that the
 * organization does not offer: a personal space cannot switch them on, so the agent would be
 * offered and unable to use them. Offer them too, in the agent's mode, or later.
 */

import { PendingButton } from "@/components/app-ui/pending-button";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "./modal";
import { ClosureList } from "./closure-list";
import { useCatalogueLibrary, useOfferOrgClosure, type OrgOfferMode } from "../hooks/use-library";
import {
  offerClosureEntries,
  offerClosureRequests,
  type OfferWarning,
} from "../lib/org-offer-closure";

export function OrgOfferClosureDialog({
  warnings,
  mode,
  onClose,
}: {
  warnings: readonly OfferWarning[];
  mode: OrgOfferMode;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings"]);
  const library = useCatalogueLibrary();
  const offerAll = useOfferOrgClosure();
  const entries = offerClosureEntries(warnings, library.data?.packages.integration ?? []);

  return (
    <Modal
      onClose={onClose}
      preventClose={offerAll.isPending}
      title={t("catalogue.orgOffer.closureTitle")}
      description={t("catalogue.orgOffer.closureBody")}
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={offerAll.isPending}>
            {t("catalogue.orgOffer.closureLater")}
          </Button>
          <PendingButton
            pending={offerAll.isPending}
            onClick={() =>
              offerAll.mutate(offerClosureRequests(entries, mode), { onSuccess: onClose })
            }
          >
            {t("catalogue.orgOffer.closureOfferAlso")}
          </PendingButton>
        </>
      }
    >
      <ClosureList
        entries={entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          note: entry.required ? t("catalogue.orgOffer.closureRequired") : undefined,
        }))}
      />
    </Modal>
  );
}
