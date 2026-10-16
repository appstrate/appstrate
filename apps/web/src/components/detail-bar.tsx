// SPDX-License-Identifier: Apache-2.0

/**
 * A detail page's identity and controls, drawn in the shell header under the
 * trail: the title with its pill and a line of meta under it, the page's actions
 * at the right end, and the tab bar (`HeaderTabBar` in `detail-tabs.tsx`) on the
 * band's own rule. The trail and the bell stay in the header's first row, as on
 * every other page: the bar publishes the page's trail (its ancestors, then its
 * own title) like any page does.
 *
 * Like every piece of the shell's slots it is a portal, so what it renders keeps
 * the page's context and leaves with the page.
 */

import type { ReactNode } from "react";
import { CopyButton } from "@appstrate/ui/components/copy-button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { usePageBreadcrumb } from "@/hooks/use-overlay-breadcrumb";
import type { BreadcrumbEntry } from "@/stores/breadcrumb-store";
import {
  ShellHeaderActions,
  ShellHeaderLead,
  ShellHeaderTabs,
} from "@/components/shell-header-slots";
import { HeaderTabBar, type DetailTab } from "@/components/detail-tabs";

/** A package's id in the small line under the title, with its copy button. */
export function DetailBarId({ id }: { id: string }) {
  return (
    <>
      <code className="truncate font-mono">{id}</code>
      <CopyButton value={id} className="size-5 shrink-0 [&_svg]:size-3" />
    </>
  );
}

export function DetailBar<T extends string = string>({
  icon,
  title,
  badge,
  trail,
  meta,
  actions,
  tabs,
}: {
  /** The identity tile, left of the title. */
  icon?: ReactNode;
  /** The page's one `<h1>`. */
  title: string;
  /** Beside the title: a version, a status. */
  badge?: ReactNode;
  /** The page's ancestors in the header trail, outermost first; the title closes it. */
  trail?: readonly BreadcrumbEntry[];
  /** In the small line under the title. */
  meta?: ReactNode;
  /**
   * The header's right end, left of the notification bell. The bar lays them out:
   * pass the controls as siblings, in the order links, the page's deed, then the
   * Actions menu, each a `HeaderActionButton` or the menu's own trigger.
   */
  actions?: ReactNode;
  /** The tab bar, on the band's rule. Needs the page's `DetailTabs` above. */
  tabs?: readonly DetailTab<T>[];
}) {
  usePageBreadcrumb([...(trail ?? []), { label: title }]);

  return (
    <>
      <ShellHeaderLead>
        <div className="flex min-w-0 items-center gap-3 md:gap-3.5">
          {icon}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-base leading-6 font-semibold md:text-[17px]">{title}</h1>
              {badge}
            </div>
            <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs leading-5 md:mt-0.5">
              {meta}
            </div>
          </div>
        </div>
      </ShellHeaderLead>
      {actions && (
        <ShellHeaderActions>
          <div className="flex items-center gap-2">{actions}</div>
        </ShellHeaderActions>
      )}
      {tabs && <HeaderTabBar tabs={tabs} />}
    </>
  );
}

/**
 * `DetailBar`'s box while the page's data is on its way, so the real title lands
 * in place: the title when a cached row already names it, blocks otherwise, and
 * a tab strip of `tabCount` blocks.
 */
export function DetailBarSkeleton({
  title,
  trail,
  tabCount = 4,
}: {
  title?: string;
  trail?: readonly BreadcrumbEntry[];
  tabCount?: number;
}) {
  usePageBreadcrumb([...(trail ?? []), ...(title ? [{ label: title }] : [])]);

  return (
    <>
      <ShellHeaderLead>
        <div className="flex min-w-0 items-center gap-3 md:gap-3.5">
          <Skeleton className="size-10 shrink-0 rounded-[10px]" />
          <div className="min-w-0">
            {title ? (
              <h1 className="truncate text-base leading-6 font-semibold md:text-[17px]">{title}</h1>
            ) : (
              <Skeleton className="my-1 h-4 w-44" />
            )}
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs leading-5 md:mt-0.5">
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </div>
      </ShellHeaderLead>
      <ShellHeaderActions>
        <Skeleton className="h-8 w-20" />
      </ShellHeaderActions>
      <ShellHeaderTabs>
        <div className="flex h-11 items-center gap-4">
          {Array.from({ length: tabCount }, (_, i) => (
            <Skeleton key={i} className="h-4 w-20" />
          ))}
        </div>
      </ShellHeaderTabs>
    </>
  );
}
