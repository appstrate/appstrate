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

/**
 * One stable page deed at every width; the menu carries the available actions.
 * `disabled` keeps the trigger where it always is when the caller may not act
 * (wrap it in a `DisabledReasonTooltip`); `contentClassName` widens the menu.
 */
export function PageActionsMenu({
  children,
  disabled = false,
  contentClassName,
}: {
  children?: ReactNode;
  disabled?: boolean;
  contentClassName?: string;
}) {
  const { t } = useTranslation("common");

  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={TOOLBAR_ACTION}
      disabled={disabled}
      data-page-actions-trigger
    >
      {t("pageActions.label")}
      <ChevronDown />
    </Button>
  );
  if (disabled) return trigger;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={contentClassName}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
