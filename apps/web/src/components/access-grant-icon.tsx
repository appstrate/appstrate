// SPDX-License-Identifier: Apache-2.0

import { Laptop, Monitor, Plug, Terminal } from "lucide-react";
import { categorizeUserAgent, type AccessGrant } from "../lib/access-grants";

/**
 * A grant's glyph. An MCP client's own icon is a third-party URL: loading it
 * would tell that third party who opened this page, so it is never fetched.
 */
export function AccessGrantIcon({ grant }: { grant: Pick<AccessGrant, "kind" | "user_agent"> }) {
  const className = "text-muted-foreground size-4 shrink-0";
  if (grant.kind === "mcp") return <Plug className={className} />;
  const category = categorizeUserAgent(grant.user_agent);
  if (category === "cli") return <Terminal className={className} />;
  if (category === "github-action") return <Monitor className={className} />;
  return <Laptop className={className} />;
}
