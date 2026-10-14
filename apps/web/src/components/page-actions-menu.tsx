// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { TOOLBAR_ACTION } from "../lib/toolbar-button";

/**
 * One deed of a page, declared once and rendered both as a menu entry
 * (`PageActionItem`) and as the button of an empty collection
 * (`EmptyStateAction`). `onSelect` runs in the app; `href` opens an external
 * page in a new tab. `hidden` drops the deed for a caller who may not do it.
 */
export type PageAction = {
  /** Becomes `data-page-action`. */
  id: string;
  icon: LucideIcon;
  label: string;
  onSelect?: () => void;
  href?: string;
  testId?: string;
  hidden?: boolean;
};

export function PageActionItem({
  action: { id, icon: Icon, label, onSelect, href, testId },
}: {
  action: PageAction;
}) {
  const content = (
    <>
      <Icon />
      {label}
    </>
  );
  return href ? (
    <DropdownMenuItem asChild>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-page-action={id}
        data-testid={testId}
      >
        {content}
      </a>
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem data-page-action={id} data-testid={testId} onSelect={onSelect}>
      {content}
    </DropdownMenuItem>
  );
}

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
