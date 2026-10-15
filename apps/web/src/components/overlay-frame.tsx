// SPDX-License-Identifier: Apache-2.0

/**
 * The one dialog of every panel overlay (settings, catalogue).
 *
 * A layout route of the overlay tree: it opens once, and whatever its panes go
 * through under it — the skeleton while a chunk or the permissions load, then
 * the page — happens inside the same box. A dialog drawn by the skeleton and
 * another by the page would be unmounted and mounted in turn when the fallback
 * hands over, replaying the backdrop's fade and the box's zoom: the overlay
 * would seem to close and open again.
 */
import { Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "@appstrate/ui/components/dialog";
import { keepOpenWhileRenaming } from "../lib/keep-open-while-renaming";
import { useCloseOverlay } from "../lib/modal-route";
import { isUnder } from "../lib/route-access";

export function OverlayFrame() {
  const { t } = useTranslation("settings");
  const { pathname } = useLocation();
  const close = useCloseOverlay();
  // Announced by assistive technology from the first frame, skeleton included.
  const title = isUnder(pathname, "/catalogue") ? t("catalogue.title") : t("unifiedSettings.title");

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        onEscapeKeyDown={keepOpenWhileRenaming}
        className={[
          "flex h-[min(720px,calc(100dvh-6rem))] w-[min(1080px,calc(100vw-4rem))] max-w-none gap-0 overflow-hidden p-0",
          // Full screen on a phone: two panes side by side do not survive
          // 390px. The shared dialog's height cap is lifted with it.
          "max-sm:h-[100dvh] max-sm:max-h-none max-sm:w-[100vw] max-sm:rounded-none max-sm:border-0",
          // The header band owns the close control at every width.
          "[&>button]:top-1.5 [&>button]:right-1.5 [&>button]:z-30 [&>button]:flex [&>button]:size-11 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-md",
        ].join(" ")}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <Outlet />
      </DialogContent>
    </Dialog>
  );
}
