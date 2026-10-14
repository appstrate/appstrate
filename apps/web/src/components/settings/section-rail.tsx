// SPDX-License-Identifier: Apache-2.0

/** The rail of a detail page's Paramètres: its sections, by group, as links. */
import type { LucideIcon } from "lucide-react";
import { RailGroup } from "./rail-shell";
import { RailLink } from "./rail-link";

export interface SectionRailItem {
  id: string;
  to: string;
  icon: LucideIcon;
  label: string;
  /** The section stays, its panel says what the role does not allow. */
  locked?: boolean;
}

export function SectionRail({
  label,
  groups,
  active,
}: {
  label: string;
  groups: ReadonlyArray<{ title: string; items: readonly SectionRailItem[] }>;
  active: string;
}) {
  return (
    <nav aria-label={label}>
      {groups.map((group, index) => (
        <RailGroup key={group.title} title={group.title} separated={index > 0}>
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <RailLink
                key={item.id}
                item={item}
                label={item.label}
                active={active === item.id}
                locked={item.locked}
              />
            ))}
          </div>
        </RailGroup>
      ))}
    </nav>
  );
}
