// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@appstrate/ui/components/sheet";

/**
 * A rail of sections on a phone: a Menu button opening it in a sheet, where two
 * panes do not fit and the whole rail would otherwise come before the content.
 * Remounted on every navigation (a section can live in the query or the hash),
 * so picking an entry closes it. The caller says from which width it steps
 * aside: the window's for a dialog, the frame's own for a split in a page.
 */
export function PhoneNavigation({
  title,
  rail,
  className,
}: {
  /** Announced to screen readers as the sheet's title. */
  title: string;
  rail: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation("common");
  const { pathname, search, hash } = useLocation();
  return (
    <Sheet key={`${pathname}${search}${hash}`}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("mb-6 h-11 w-full justify-between bg-transparent px-3", className)}
        >
          <span className="truncate">{t("panelDialog.menu")}</span>
          <ChevronDown className="size-4 shrink-0" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        aria-describedby={undefined}
        className="bg-sidebar flex w-[min(20rem,85vw)] flex-col gap-0 p-0"
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <ScrollArea className="min-h-0 flex-1">{rail}</ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
