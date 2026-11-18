// SPDX-License-Identifier: Apache-2.0

/** The chat's MCP loopback bearer, as a test sends it. */

import type { OrgRole } from "@appstrate/core/permissions";
import { mintMcpLoopbackToken } from "../../../../packages/module-chat/src/loopback-auth.ts";
import type { TestContext } from "./auth.ts";

/**
 * `member`'s loopback headers in `orgId`, capped at `permissions`. `spaceIds` is the space
 * allowlist the bearer carries (`AuthResolution.spaceIds`, `credentialSpaceIds`); absent, it is
 * unbound. `chatSessionId` is the conversation the turn's bearer names as issuing it.
 */
export function loopbackHeaders(
  member: Pick<TestContext, "user">,
  orgId: string,
  options: {
    orgRole: OrgRole;
    permissions: string[];
    spaceIds?: string[];
    chatSessionId?: string;
    /** The role preview the turn runs under, as the chat signs it. */
    viewAs?: unknown;
  },
): Record<string, string> {
  const token = mintMcpLoopbackToken({
    userId: member.user.id,
    email: member.user.email,
    name: member.user.name,
    orgId,
    orgRole: options.orgRole,
    permissions: options.permissions,
    spaceIds: options.spaceIds,
    chatSessionId: options.chatSessionId,
    viewAs: options.viewAs,
  });
  return { Authorization: `Bearer ${token}`, "X-Org-Id": orgId };
}

/** `member`'s loopback headers in `orgId` (org role `member`), capped at `permissions`. */
export function memberLoopbackHeaders(
  member: Pick<TestContext, "user">,
  orgId: string,
  permissions: string[],
): Record<string, string> {
  return loopbackHeaders(member, orgId, { orgRole: "member", permissions });
}
