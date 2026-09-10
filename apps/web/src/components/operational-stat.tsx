// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { Link, type To } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
export function OperationalStat({
  label,
  value,
  to,
  className,
}: {
  label: string;
  value: ReactNode;
  to?: To;
  className?: string;
}) {
  const content = (
    <>
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </>
  );

  return (
    <div className={cn("min-w-0", className)}>
      {to ? (
        <Link
          className="group hover:bg-muted/20 focus-visible:ring-ring relative flex h-full min-h-20 flex-col justify-center px-4 py-4 pr-10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
          to={to}
        >
          {content}
          <ArrowRight className="text-muted-foreground/45 group-hover:text-primary group-focus-visible:text-primary absolute top-1/2 right-4 size-4 -translate-y-1/2 opacity-70 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:translate-x-0.5 group-focus-visible:opacity-100" />
        </Link>
      ) : (
        <div className="flex h-full min-h-20 flex-col justify-center px-4 py-4">{content}</div>
      )}
    </div>
  );
}
