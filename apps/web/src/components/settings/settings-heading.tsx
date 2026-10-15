// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";

/** Shared hierarchy for organization, workspace, package and bundle settings. */
export function SettingsHeading({
  title,
  description,
  level = "page",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  level?: "page" | "group";
  className?: string;
}) {
  const Heading = level === "page" ? "h2" : "h3";
  return (
    <header className={cn(level === "page" ? "mb-6" : "mb-4", className)}>
      <Heading className={cn("font-semibold", level === "page" ? "text-xl" : "text-base")}>
        {title}
      </Heading>
      {description && (
        <div className="text-muted-foreground mt-1 max-w-2xl text-sm leading-relaxed">
          {description}
        </div>
      )}
    </header>
  );
}
