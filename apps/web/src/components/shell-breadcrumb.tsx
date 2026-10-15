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
import { useCanReach } from "@/hooks/use-can-reach";
import { useOverlayPath } from "@/lib/modal-route";

/**
 * The header's slot elements. The trail is drawn twice (the desktop row and the
 * phone row, one of them hidden), so a slot entry has one element per drawing and
 * `ShellTrailContent` fills each.
 */
const trailSlots = createStore<{ elements: HTMLElement[] }>(() => ({ elements: [] }));

function registerTrailSlot(element: HTMLElement | null) {
  if (!element) return;
  trailSlots.setState((s) => ({ elements: [...s.elements, element] }));
  return () => trailSlots.setState((s) => ({ elements: s.elements.filter((e) => e !== element) }));
}

/**
 * What a page shows in its `slot` trail entry. It is rendered where the page
 * renders it, so it reads the page's context, and portalled into the header.
 */
export function ShellTrailContent({ children }: { children: ReactNode }) {
  const elements = useStore(trailSlots, (s) => s.elements);
  return elements.map((element, i) => (
    <Fragment key={i}>{createPortal(children, element)}</Fragment>
  ));
}

function Separator() {
  return (
    <span className="text-border shrink-0 select-none" aria-hidden>
      /
    </span>
  );
}

export function ShellBreadcrumb() {
  const { t } = useTranslation("common");
  const overlayOpen = useOverlayPath() !== null;
  const entries = useStore(
    breadcrumbStore,
    useShallow((s) => visibleTrail(s, overlayOpen)),
  );
  const canReach = useCanReach();

  return (
    <nav
      aria-label={t("nav.breadcrumb")}
      className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm"
    >
      {entries.map((crumb, i) => (
        <Fragment key={i}>
          {i > 0 && <Separator />}
          {crumb.slot ? (
            <span ref={registerTrailSlot} className="flex min-w-0" />
          ) : crumb.href && canReach(crumb.href) ? (
            <Link
              to={crumb.href}
              className="text-muted-foreground hover:text-foreground truncate transition-colors"
            >
              {crumb.label}
            </Link>
          ) : crumb.href ? (
            // A parent the caller may not open: named, not linked.
            <span className="text-muted-foreground truncate">{crumb.label}</span>
          ) : (
            // Last segment: where you are, so it carries the weight.
            <span className="truncate font-semibold">{crumb.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
