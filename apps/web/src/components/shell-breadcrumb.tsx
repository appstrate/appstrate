// SPDX-License-Identifier: Apache-2.0

/** The header trail: the open overlay's, else the current page's (see `breadcrumb-store`). */
import { Fragment, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useShallow } from "zustand/react/shallow";
import { breadcrumbStore, visibleTrail } from "@/stores/breadcrumb-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useCanReach } from "@/hooks/use-can-reach";
import { useOverlayPath } from "@/lib/modal-route";
import { cn } from "@appstrate/ui/cn";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@appstrate/ui/components/breadcrumb";

/** The header's slot element, which `ShellTrailContent` fills. */
const trailSlot = createStore<{ element: HTMLElement | null }>(() => ({ element: null }));

function registerTrailSlot(element: HTMLElement | null) {
  if (!element) return;
  trailSlot.setState({ element });
  return () => trailSlot.setState((s) => (s.element === element ? { element: null } : s));
}

/**
 * What a page shows in its `slot` trail entry. It is rendered where the page
 * renders it, so it reads the page's context, and portalled into the header.
 */
export function ShellTrailContent({ children }: { children: ReactNode }) {
  const element = useStore(trailSlot, (s) => s.element);
  return element && createPortal(children, element);
}

export function ShellBreadcrumb() {
  const { t } = useTranslation("common");
  const overlayOpen = useOverlayPath() !== null;
  const entries = useStore(
    breadcrumbStore,
    useShallow((s) => visibleTrail(s, overlayOpen)),
  );
  const canReach = useCanReach();
  useDocumentTitle(entries);

  return (
    <Breadcrumb
      aria-label={t("nav.breadcrumb")}
      data-trail
      className="flex min-w-0 flex-1 overflow-hidden"
    >
      <BreadcrumbList className="min-w-0 flex-nowrap gap-1.5 sm:gap-1.5">
        {entries.map((crumb, i) => (
          // A phone's header has room for where you are: the last segment alone.
          <Fragment key={i}>
            {i > 0 && (
              <BreadcrumbSeparator className="text-border shrink-0 select-none max-md:hidden">
                /
              </BreadcrumbSeparator>
            )}
            <BreadcrumbItem className={cn("min-w-0", i < entries.length - 1 && "max-md:hidden")}>
              {crumb.slot ? (
                <span ref={registerTrailSlot} className="flex min-w-0" />
              ) : crumb.href && canReach(crumb.href) ? (
                <BreadcrumbLink asChild className="truncate">
                  <Link to={crumb.href}>{crumb.label}</Link>
                </BreadcrumbLink>
              ) : crumb.href ? (
                // A parent the caller may not open: named, not linked.
                <span className="truncate">{crumb.label}</span>
              ) : (
                // Last segment: where you are, so it carries the weight.
                <BreadcrumbPage className="truncate font-semibold">{crumb.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
