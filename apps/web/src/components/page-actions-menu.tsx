// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { TOOLBAR_ACTION } from "../lib/toolbar-button";

/** One stable page deed at every width; the menu carries the available actions. */
export function PageActionsMenu({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={TOOLBAR_ACTION}
          data-page-actions-trigger
        >
          {t("pageActions.label")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
