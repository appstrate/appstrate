// SPDX-License-Identifier: Apache-2.0

/**
 * What a role does not let the reader see or do, said where the content would
 * be. Tabs and sections stay the same for every role (the chat's read-only
 * composer is the same idea): what changes with the role is the content, never
 * the navigation of the page.
 */

import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";

export function RoleLimitNotice({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Alert role="note" icon={Lock} className={className}>
      <AlertDescription className="text-muted-foreground">{children}</AlertDescription>
    </Alert>
  );
}
