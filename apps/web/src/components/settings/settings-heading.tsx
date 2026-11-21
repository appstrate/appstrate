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
  level?: "page" | "group" | "sub";
  className?: string;
}) {
  const Heading = level === "page" ? "h2" : level === "group" ? "h3" : "h4";
  return (
    <header
      className={cn(level === "page" ? "mb-6" : level === "group" ? "mb-4" : "mb-3", className)}
    >
      <Heading
        className={cn(
          "font-semibold",
          level === "page" ? "text-xl" : level === "group" ? "text-base" : "text-sm",
        )}
      >
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
