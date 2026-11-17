// SPDX-License-Identifier: Apache-2.0

/** The chat's MCP loopback bearer for a member, as a test sends it. */

import { mintMcpLoopbackToken } from "../../../../packages/module-chat/src/loopback-auth.ts";
import type { TestContext } from "./auth.ts";

/** `member`'s loopback headers in `orgId` (org role `member`), capped at `permissions`. */
export function memberLoopbackHeaders(
  member: Pick<TestContext, "user">,
  orgId: string,
  permissions: string[],
): Record<string, string> {
  const token = mintMcpLoopbackToken({
    userId: member.user.id,
    email: member.user.email,
    name: member.user.name,
    orgId,
    orgRole: "member",
    permissions,
  });
  return { Authorization: `Bearer ${token}`, "X-Org-Id": orgId };
}
