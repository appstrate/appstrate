// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Link, type To } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { cn } from "@appstrate/ui/cn";

/**
 * Where a clickable summary leads: a route (`to`, a real link the reader can
 * open in a new tab) or an in-place deed (`onClick`, a button). Never both.
 */
export type ActionTarget = { to: To; onClick?: never } | { to?: never; onClick: () => void };

/** A link when the target is a route, a button when it is a deed. */
export function TargetLink({
  target,
  className,
  label,
  children,
}: {
  target: ActionTarget;
  className?: string;
  /** Accessible name and tooltip, for a target whose content does not name it. */
  label?: string;
  children: ReactNode;
}) {
  return target.to !== undefined ? (
    <Link to={target.to} aria-label={label} title={label} className={className}>
      {children}
    </Link>
  ) : (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={target.onClick}
      className={className}
    >
      {children}
    </button>
  );
}

/** The arrow of a `TargetLink`; the link must carry the `group` class. */
export function TargetArrow({ className }: { className?: string }) {
  return (
    <ArrowRight
      aria-hidden
      className={cn(
        "group-hover:text-primary group-focus-visible:text-primary shrink-0 transition-all group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5",
        className,
      )}
    />
  );
}
