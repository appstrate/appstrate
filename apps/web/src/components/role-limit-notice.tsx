// SPDX-License-Identifier: Apache-2.0

/**
 * What a role does not let the reader see or do, said where the content would
 * be. Tabs and sections stay the same for every role (the chat's read-only
 * composer is the same idea): what changes with the role is the content, never
 * the navigation of the page.
 */

import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { cn } from "@appstrate/ui/cn";

export function RoleLimitNotice({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="note"
      className={cn(
        "border-border bg-muted/40 text-muted-foreground flex items-start gap-2 rounded-lg border px-4 py-3 text-sm",
        className,
      )}
    >
      <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
