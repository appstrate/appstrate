// SPDX-License-Identifier: Apache-2.0

import type { ApiCommandIO } from "./types.ts";

/**
 * Curl-style request trace. Always writes to stderr (bypasses `-s` —
 * curl does the same: `-sv` keeps the trace). Authorization is always
 * `[REDACTED]` — the whole point of this CLI is that the agent never
 * sees the raw bearer, and `-v` output is quoted in CI logs, issues,
 * Discord screenshots, etc.
 */
export function writeVerboseRequest(
  io: ApiCommandIO,
  profileName: string,
  method: string,
  url: string,
  headers: Record<string, string>,
): void {
  const u = new URL(url);
  io.stderr.write(`* Profile: "${profileName}" → ${u.origin}\n`);
  io.stderr.write(`* Bearer injected from keyring, never exposed to caller\n`);
  io.stderr.write(`> ${method} ${u.pathname}${u.search} HTTP/1.1\r\n`);
  io.stderr.write(`> Host: ${u.host}\r\n`);
  for (const [k, v] of Object.entries(headers)) {
    // Any header named Authorization is redacted, regardless of casing
    // (`-H authorization: …` overrides our injected default but we
    // still hide it — the hash in the value is sensitive).
    const display = k.toLowerCase() === "authorization" ? "Bearer [REDACTED]" : v;
    io.stderr.write(`> ${k}: ${display}\r\n`);
  }
  io.stderr.write(`>\r\n`);
}

export function writeVerboseResponse(io: ApiCommandIO, res: Response): void {
  io.stderr.write(`< HTTP/1.1 ${res.status} ${res.statusText || ""}\r\n`);
  for (const [k, v] of res.headers) {
    io.stderr.write(`< ${k}: ${v}\r\n`);
  }
  io.stderr.write(`<\r\n`);
}
