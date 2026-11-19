// SPDX-License-Identifier: Apache-2.0

import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@appstrate/ui/components/dropdown-menu";
import { PageActionsMenu } from "../page-actions-menu";
import type { PackageMenuGroup } from "./package-menu";
import { SpaceChoiceSubmenu } from "../space-choice-menu";
import { usePackageActions, type PackageActionsDropdownProps } from "./use-package-actions";

const GROUP_LABELS: Record<PackageMenuGroup, string> = {
  build: "detail.actions.agent",
  execution: "detail.actions.execution",
  export: "detail.actions.export",
  administration: "detail.actions.administration",
};

/** A disabled menu item takes no focus or pointer event: its reason is shown, not titled. */
function DisabledItemLabel({ label, reason }: { label: string; reason?: string }) {
  if (!reason) return label;
  return (
    <span className="flex max-w-56 flex-col">
      {label}
      <span className="text-xs">{reason}</span>
    </span>
  );
}

export function PackageActionsDropdown(props: PackageActionsDropdownProps) {
  const { sections, dialogs } = usePackageActions(props);
  const { t } = useTranslation("agents");
  return (
    <>
      <PageActionsMenu contentClassName={props.agent ? "min-w-64" : undefined}>
        {sections.map(({ group, entries: items }, index) => (
          <Fragment key={group}>
            {index > 0 && <DropdownMenuSeparator />}
            {props.agent && <DropdownMenuLabel>{t(GROUP_LABELS[group])}</DropdownMenuLabel>}
            {items.map((entry) =>
              // The reader chooses the space first: the entry opens the menu of them.
              entry.inSpaces && !entry.disabled && !entry.reason ? (
                <SpaceChoiceSubmenu
                  key={entry.id}
                  choice={entry.inSpaces}
                  trigger={
                    <>
                      <entry.icon />
                      {entry.label}
                    </>
                  }
                />
              ) : (
                <DropdownMenuItem
                  key={entry.id}
                  disabled={entry.disabled || !!entry.reason}
                  onSelect={entry.onSelect}
                  className={cn(entry.destructive && "text-destructive focus:text-destructive")}
                >
                  <entry.icon />
                  <DisabledItemLabel label={entry.label} reason={entry.reason} />
                </DropdownMenuItem>
              ),
            )}
          </Fragment>
        ))}
      </PageActionsMenu>
      {dialogs}
    </>
  );
}
