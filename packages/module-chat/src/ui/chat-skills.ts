// SPDX-License-Identifier: Apache-2.0

/** The skill picker's data and pure rules. */

import { z } from "zod";
import { parseScopedName } from "@appstrate/core/naming";
import { MAX_PINNED_SKILLS, parseSkillList, type SkillHint } from "../skills.ts";
import type { ChatTransport } from "./runtime-context.ts";
import { chatPath } from "./chat-route.ts";

/** A row of the organization index lists the spaces it is active in; the rest is `parseSkillList`'s. */
const spacedRowSchema = z.looseObject({ space_ids: z.array(z.string()) });

/**
 * The active skills the picker chooses from: those active in a space the chat acts in
 * (`actingSpaceIds`). The organization index lists each package once.
 */
export async function fetchSkills(
  transport: ChatTransport,
  actingSpaceIds: readonly string[],
): Promise<SkillHint[]> {
  const res = await transport.request(`/api/orgs/${transport.orgId}/packages/skills`);
  const body: unknown = await res.json();
  const acting = new Set(actingSpaceIds);
  const rows = (body as { data?: unknown } | null)?.data;
  const kept = (Array.isArray(rows) ? rows : []).flatMap((row: unknown) => {
    const parsed = spacedRowSchema.safeParse(row);
    return parsed.success && parsed.data.space_ids.some((id) => acting.has(id))
      ? [parsed.data]
      : [];
  });
  return parseSkillList({ data: kept });
}

const enforcedSkillsSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.object({ id: z.string(), name: z.string(), version: z.string().nullable() })),
});

/** What `spaceId` imposes, through the chat module (`chat:write`): a member without `skills:read` sees them too. */
export async function fetchEnforcedSkills(
  transport: ChatTransport,
  spaceId: string,
): Promise<SkillHint[]> {
  const res = await transport.request(
    chatPath(transport, `/enforced-skills?${new URLSearchParams({ spaceId })}`),
  );
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
