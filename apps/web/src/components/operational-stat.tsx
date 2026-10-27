// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import { TargetArrow, TargetLink, type ActionTarget } from "./action-target";

const TARGET_CLASS =
  "group hover:bg-muted/20 focus-visible:ring-ring relative flex size-full min-h-20 flex-col justify-center px-4 py-4 pr-10 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset";

/**
 * One figure of a summary strip: a label over its value, inside a `<dl>`.
 * With a target the whole tile leads there, arrow included.
 * `size="sm"` is for a value that is a sentence or a date rather than a count.
 */
export function OperationalStat({
  label,
  value,
  size = "md",
  className,
  target,
}: {
  label: ReactNode;
  value: ReactNode;
  size?: "md" | "sm";
  className?: string;
  target?: ActionTarget;
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

  return (
    <div className={cn("min-w-0", className)}>
      {target ? (
        <TargetLink target={target} className={TARGET_CLASS}>
          {content}
          <TargetArrow className="text-muted-foreground/45 absolute top-1/2 right-4 size-4 -translate-y-1/2 opacity-70 group-hover:opacity-100 group-focus-visible:opacity-100" />
        </TargetLink>
      ) : (
        <div className="flex h-full min-h-20 flex-col justify-center px-4 py-4">{content}</div>
      )}
    </div>
  );
}
