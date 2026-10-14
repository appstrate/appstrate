// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { Link, type To } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { cn } from "@appstrate/ui/cn";

const TARGET_CLASS =
  "group hover:bg-muted/20 focus-visible:ring-ring relative flex h-full min-h-20 w-full flex-col justify-center px-4 py-4 pr-10 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset";

/**
 * One figure of a summary strip: a label over its value, inside a `<dl>`.
 * With a target the whole tile leads there, arrow included: `to` (a link) wins
 * over `onClick` (a button).
 * `size="sm"` is for a value that is a sentence or a date rather than a count.
 */
export function OperationalStat({
  label,
  value,
  size = "md",
  className,
  to,
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  size?: "md" | "sm";
  className?: string;
  to?: To;
  onClick?: () => void;
}) {
  const content = (
    <>
      <dt className="text-muted-foreground w-full text-xs font-medium">{label}</dt>
      <dd
        className={cn(
          "mt-1 w-full",
          size === "md" ? "text-xl font-semibold tabular-nums" : "truncate text-sm",
        )}
      >
        {value}
      </dd>
    </>
  );
  const arrow = (
    <ArrowRight className="text-muted-foreground/45 group-hover:text-primary group-focus-visible:text-primary absolute top-1/2 right-4 size-4 -translate-y-1/2 opacity-70 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100" />
  );

  return (
    <div className={cn("min-w-0", className)}>
      {to !== undefined ? (
        <Link className={TARGET_CLASS} to={to}>
          {content}
          {arrow}
        </Link>
      ) : onClick ? (
        <button type="button" className={TARGET_CLASS} onClick={onClick}>
          {content}
          {arrow}
        </button>
      ) : (
        <div className="flex h-full min-h-20 flex-col justify-center px-4 py-4">{content}</div>
      )}
    </div>
  );
}
