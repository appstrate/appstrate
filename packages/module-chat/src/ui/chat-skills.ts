// SPDX-License-Identifier: Apache-2.0

/** The skill picker's data and pure rules. */

import { z } from "zod";
import { parseScopedName } from "@appstrate/core/naming";
import { MAX_PINNED_SKILLS, parseSkillList, type SkillHint } from "../skills.ts";
import type { ChatTransport } from "./runtime-context.ts";
import { chatPath } from "./chat-route.ts";

/**
 * The active skills the picker chooses from: those of the spaces the chat acts in
 * (`actingSpaceIds`; one per package).
 */
export async function fetchSkills(
  transport: ChatTransport,
  actingSpaceIds: readonly string[],
): Promise<SkillHint[]> {
  const res = await transport.request(`/api/orgs/${transport.orgId}/packages/skills`);
  const body: unknown = await res.json();
  // The organization index lists a package once per space it is active in (each row names its
  // `spaceId`): keep the rows of the spaces the chat acts in, then one per package.
  const acting = new Set(actingSpaceIds);
  const rows = (body as { data?: unknown } | null)?.data;
  const kept = {
    data: (Array.isArray(rows) ? rows : []).filter((row) => acting.has(row?.spaceId)),
  };
  const seen = new Set<string>();
  return parseSkillList(kept).filter(
    (skill) => !seen.has(skill.packageId) && seen.add(skill.packageId),
  );
}

const enforcedSkillsSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.object({ id: z.string(), name: z.string(), version: z.string().nullable() })),
});

/** Through the chat module (`chat:write`): a member without `skills:read` sees them too. */
export async function fetchEnforcedSkills(transport: ChatTransport): Promise<SkillHint[]> {
  const res = await transport.request(chatPath(transport, "/enforced-skills"));
  // Strict: a policy read that drifted must fail loudly, never read as "nothing imposed".
  const parsed = enforcedSkillsSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("Unexpected enforced skills response");
  return parsed.data.data.map(({ id, name, version }) => ({
    packageId: id,
    display_name: name,
    version,
  }));
}

/** An enforced skill is injected anyway: a pin naming it is not counted nor re-sent. */
export function ownPins(pinned: readonly string[], enforced: ReadonlySet<string>): string[] {
  return pinned.filter((id) => !enforced.has(id));
}

/** The cap counts the user's own pins: enforced skills never spend it. */
export function pinCapReached(stored: readonly string[], enforced: ReadonlySet<string>): boolean {
  return ownPins(stored, enforced).length >= MAX_PINNED_SKILLS;
}

/** Pin/unpin. The picker disables a new pin at the cap; the route refuses one past it. */
export function togglePinned(pinned: readonly string[], packageId: string): string[] {
  return pinned.includes(packageId)
    ? pinned.filter((id) => id !== packageId)
    : [...pinned, packageId];
}

/**
 * A choosable picker row: the catalogue, then every pin missing from it
 * (`available: false`, named by its package's bare name), so a dead pin can
 * still be removed. Enforced skills are
 * listed apart, locked.
 */
export function skillPickerRows(
  catalogue: readonly SkillHint[],
  pinned: readonly string[],
  enforced: ReadonlySet<string> = new Set(),
): { skill: SkillHint; available: boolean }[] {
  const listed = new Set(catalogue.map((skill) => skill.packageId));
  const dead = ownPins(pinned, enforced).filter((id) => !listed.has(id));
  return [
    ...catalogue
      .filter((skill) => !enforced.has(skill.packageId))
      .map((skill) => ({ skill, available: true })),
    ...dead.map((id) => ({
      skill: { packageId: id, display_name: parseScopedName(id)?.name ?? id },
      available: false,
    })),
  ];
}
