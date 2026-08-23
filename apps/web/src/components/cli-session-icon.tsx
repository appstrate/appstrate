// SPDX-License-Identifier: Apache-2.0

import { Laptop, Monitor, Terminal } from "lucide-react";
import { categorizeUserAgent } from "../lib/cli-sessions";

export function CliSessionIcon({ userAgent }: { userAgent: string | null }) {
  const className = "text-muted-foreground h-4 w-4 shrink-0";
  const category = categorizeUserAgent(userAgent);

  if (category === "cli") return <Terminal className={className} />;
  if (category === "github-action") return <Monitor className={className} />;
  return <Laptop className={className} />;
}
