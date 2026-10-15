// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useCloseOverlay } from "../lib/modal-route";
import { Modal } from "./modal";

/** An address under an overlay that names no page of it: said over the page beneath. */
export function OverlayUnavailable() {
  const { t } = useTranslation("common");
  const close = useCloseOverlay();
  return (
    <Modal onClose={close} title={t("access.unavailable")}>
      <p className="text-muted-foreground text-sm">{t("access.unavailableHint")}</p>
    </Modal>
  );
}
