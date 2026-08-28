// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Link, type To } from "react-router-dom";
import { ArrowRight } from "lucide-react";

type OverviewCardActionProps = {
  children: ReactNode;
} & (
  | { to: To; onClick?: never }
  | {
      to?: never;
      onClick: () => void;
    }
);

const className =
  "text-primary hover:bg-muted/40 focus-visible:ring-ring group flex min-h-9 w-full cursor-pointer items-center justify-start border-t px-4 py-2 text-left text-xs font-normal transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset";

/** One quiet, full-width footer action for operational summary cards. */
export function OverviewCardAction({ children, ...action }: OverviewCardActionProps) {
  const label = (
    <>
      <span>{children}</span>
      <ArrowRight
        className="text-muted-foreground/45 group-hover:text-primary group-focus-visible:text-primary ml-auto size-3.5 opacity-70 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100"
        aria-hidden
      />
    </>
  );

  return "to" in action && action.to !== undefined ? (
    <Link to={action.to} className={className}>
      {label}
    </Link>
  ) : (
    <button type="button" className={className} onClick={action.onClick}>
      {label}
    </button>
  );
}
