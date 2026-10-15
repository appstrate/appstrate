// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useCloseOverlay } from "../lib/modal-route";
import { Modal } from "./modal";
import { PanelMessage } from "./panel-layout";
import { UnavailableState } from "./route-gate";

/** An address under an overlay that names no page of it: said over the page beneath. */
export function OverlayUnavailable() {
  const { t } = useTranslation("common");
  const close = useCloseOverlay();
  return (
    <Modal open onClose={close} title={t("access.unavailable")}>
      <p className="text-muted-foreground text-sm">{t("access.unavailableHint")}</p>
    </Modal>
  );
}

/** The same, for an address a panel overlay's own route rejects: said in the panel already open. */
export function PanelUnavailable() {
  return (
    <PanelMessage>
      <UnavailableState />
    </PanelMessage>
  );
}
