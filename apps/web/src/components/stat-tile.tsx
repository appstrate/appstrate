// SPDX-License-Identifier: Apache-2.0

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Dashboard metric tile — label + soft-tinted icon, large value, optional sub. */
export function StatTile({
  label,
  value,
  icon: Icon,
  tint = "primary",
  sub,
  subDir,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tint?: "primary" | "success" | "warning" | "spark";
  sub?: string;
  subDir?: "up" | "down";
}) {
  const tintClass = {
    primary: "bg-primary-soft text-primary",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    spark: "bg-spark-soft text-spark",
  }[tint];

  return (
    <div className="bg-card border-border rounded-[var(--radius)] border p-4 shadow-sm">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-muted-foreground text-[0.78rem] font-medium">{label}</span>
        <span className={cn("flex size-8 items-center justify-center rounded-lg", tintClass)}>
          <Icon className="size-[17px]" />
        </span>
      </div>
      <div className="text-[1.95rem] leading-none font-bold tracking-tight">{value}</div>
      {sub && (
        <div className="text-muted-foreground mt-1.5 text-[0.78rem]">
          <span
            className={cn(
              subDir === "up" && "text-success font-semibold",
              subDir === "down" && "text-destructive font-semibold",
            )}
          >
            {sub}
          </span>
        </div>
      )}
    </div>
  );
}
