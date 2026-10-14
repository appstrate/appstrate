// SPDX-License-Identifier: Apache-2.0

import { Children, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { TOOLBAR_ACTION } from "../lib/toolbar-button";
import { MenuActionItem, type MenuAction } from "./menu-action";

/**
 * One stable page deed at every width; the menu carries the available actions:
 * `actions` first, then any `children` (an entry `MenuAction` cannot say). With
 * nothing to offer it renders nothing. `disabled` keeps the trigger where it
 * always is when the caller may not act (wrap it in a `DisabledReasonTooltip`);
 * `contentClassName` widens the menu.
 */
export function PageActionsMenu({
  actions,
  children,
  disabled = false,
  contentClassName,
}: {
  actions?: readonly MenuAction[];
  children?: ReactNode;
  disabled?: boolean;
  contentClassName?: string;
}) {
  const { t } = useTranslation("common");
  const offered = (actions ?? []).filter((action) => !action.hidden);
  const hasChildren = Children.toArray(children).length > 0;

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
  if (offered.length === 0 && !hasChildren) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={contentClassName}>
        {offered.map((action) => (
          <MenuActionItem key={action.id} action={action} pageAction />
        ))}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
