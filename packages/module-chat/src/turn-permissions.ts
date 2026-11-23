// SPDX-License-Identifier: Apache-2.0

import { PACKAGE_WRITE_PERMISSIONS, type OrgLevelPermission } from "@appstrate/core/permissions";

/**
 * The permissions a chat turn acts with: the caller's own, minus the write on
 * every package type when package authoring is off, and minus every `skills:*`
 * when skill discovery is off. The turn's MCP loopback token is minted from this
 * set, so the platform's existing guards refuse creating, editing or importing
 * any package and composing an inline agent (which needs `agents:write` AND
 * `agents:run`), and with discovery off any skill
 * act: listing, loading, declaring — and writing, whose response echoes the
 * `SKILL.md`. The pinned skills reach the model injected, read with the caller's
 * own authority. The switches only narrow the caller's grants, never widen them.
 */
const WRITES: ReadonlySet<string> = new Set(PACKAGE_WRITE_PERMISSIONS);

export function turnPermissions(
  permissions: Iterable<string>,
  opts: { authoring: boolean; skillDiscovery: boolean },
): string[] {
  return [...permissions].filter(
    (permission) =>
      !(!opts.authoring && WRITES.has(permission)) &&
      !(!opts.skillDiscovery && permission.startsWith("skills:")),
  );
}

/**
 * Whether a turn (and the composer's commands) works on drafts: authoring on and `skills:write`
 * held. Every skill it lists, injects or pins is then the caller's draft when one exists.
 */
export function turnUsesDrafts(
  callerPermissions: ReadonlySet<string>,
  opts: { authoring: boolean },
): boolean {
  return opts.authoring && callerPermissions.has("skills:write");
}

/**
 * The org-level permissions a limited conversation keeps: reads the turn needs to work in its
 * origin space, none of which reaches beyond what that space's own pages already show.
 *   - `org:read`: the organization the conversation belongs to (its name, in `get_me`).
 *   - `spaces:read`: the spaces list and detail, which the tools read to address the origin space.
 *   - `members:read`: the people of the organization, to name a member (a share, a space member).
 *   - `models:read`: the models an agent or an inline run of the origin space can be set to.
 */
const LIMITED_ORG_READS: ReadonlySet<string> = new Set<OrgLevelPermission>([
  "org:read",
  "spaces:read",
  "members:read",
  "models:read",
]);

/**
 * The permissions of a conversation limited to its origin space: its space-level grants, and of
 * the org-level half (`orgHalf`, every space's share of the set) only {@link LIMITED_ORG_READS}.
 * An org-level resource (a proxy, an org model or credential, an org OAuth client, an invitation,
 * the organization's settings) serves every space, so a conversation limited to one neither
 * creates nor changes one, whatever the caller's org role grants. An unlimited conversation keeps
 * its org-level grants: it acts for the caller across their spaces.
 */
export function limitedConversationPermissions(
  permissions: Iterable<string>,
  orgHalf: ReadonlySet<string>,
): string[] {
  return [...permissions].filter(
    (permission) => !orgHalf.has(permission) || LIMITED_ORG_READS.has(permission),
  );
}

/**
 * The caller's grants a turn (or the `/` menu) starts from: the union over its spaces' grants,
 * narrowed by {@link limitedConversationPermissions} for a conversation limited to one space. A
 * CEILING on the bearer (each space entry recomputes `(org ∪ role) ∩ ceiling`,
 * `lib/auth-pipeline.ts`), so no space's grants reach another.
 */
export function callerGrants(
  spaces: readonly { permissions: readonly string[] }[],
  restricted: boolean,
  orgHalf: ReadonlySet<string>,
): ReadonlySet<string> {
  const union = spaces.flatMap((space) => space.permissions);
  return new Set(restricted ? limitedConversationPermissions(union, orgHalf) : union);
}
