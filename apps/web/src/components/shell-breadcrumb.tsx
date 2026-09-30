// SPDX-License-Identifier: Apache-2.0

/**
 * The header trail: the org/workspace chip, then whatever the current page
 * published to the breadcrumb store.
 *
 * The chip is the first item on purpose. Every page in the app is scoped by an
 * organisation AND an application (they ride on `X-Org-Id` / `X-Application-Id`
 * for every request), so a trail that starts below them is not just terse, it
 * is wrong — which is what the generic "Organisation" root it replaces was.
 */
import { Fragment } from "react";
import { Link } from "react-router-dom";
import { useBreadcrumbStore } from "@/stores/breadcrumb-store";
import { useCanReach } from "@/hooks/use-can-reach";

function Separator() {
  return (
    <span className="text-border shrink-0 select-none" aria-hidden>
      /
    </span>
  );
}

export function ShellBreadcrumb() {
  const entries = useBreadcrumbStore((s) => s.entries);
  const canReach = useCanReach();

  return (
    <nav
      aria-label="breadcrumb"
      className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm"
    >
      {entries.map((crumb, i) => (
        <Fragment key={i}>
          {i > 0 && <Separator />}
          {crumb.node ? (
            crumb.node
          ) : crumb.href && canReach(crumb.href) ? (
            <Link
              to={crumb.href}
              className="text-muted-foreground hover:text-foreground truncate transition-colors"
            >
              {crumb.label}
            </Link>
          ) : crumb.href ? (
            // A parent the caller may not open: named, not linked (#1569).
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
