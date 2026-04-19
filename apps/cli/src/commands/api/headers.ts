// SPDX-License-Identifier: Apache-2.0

import { CLI_USER_AGENT } from "../../lib/version.ts";

export function buildHeaders(args: {
  userHeaders: string[];
  token: string;
  orgId?: string;
  appId?: string;
  userAgent?: string;
  referer?: string;
  cookie?: string;
  range?: string;
  compressed?: boolean;
}): Record<string, string> {
  // Merge order matters — defaults first, shortcut flags next (they
  // override defaults), user `-H` headers last (override everything).
  const out: Record<string, string> = {
    "User-Agent": args.userAgent ?? CLI_USER_AGENT,
    Authorization: `Bearer ${args.token}`,
  };
  if (args.orgId) out["X-Org-Id"] = args.orgId;
  if (args.appId) out["X-App-Id"] = args.appId;
  if (args.compressed) out["Accept-Encoding"] = "gzip, deflate, br";
  if (args.range) out["Range"] = `bytes=${args.range}`;
  if (args.referer) out["Referer"] = args.referer;
  if (args.cookie) out["Cookie"] = args.cookie;
  for (const raw of args.userHeaders) {
    const colon = raw.indexOf(":");
    if (colon === -1) continue; // silently ignore malformed — matches curl
    const name = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}
