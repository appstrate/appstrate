// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SidebarNavList } from "./app-sidebar";

/** Slide-over navigation drawer for screens below the `md` breakpoint. */
export function MobileNav({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="bg-sidebar w-[260px] gap-0 p-0">
        <SheetTitle className="sr-only">{t("nav.ariaLabel")}</SheetTitle>
        <SidebarNavList onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
