// SPDX-License-Identifier: Apache-2.0

/** The skill picker's data and pure rules. */

import { z } from "zod";
import { parseSkillList, type SkillHint } from "../skills.ts";
import type { GetHeaders } from "./runtime-context.ts";

/** The space's active skills, the ones the picker chooses from. */
export async function fetchSkills(getHeaders: GetHeaders | null | undefined): Promise<SkillHint[]> {
  const res = await fetch("/api/packages/skills", {
    credentials: "include",
    headers: { ...getHeaders?.() },
  });
  if (!res.ok) throw new Error(`Failed to load skills (HTTP ${res.status})`);
  return parseSkillList(await res.json());
}

const enforcedSkillsSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.object({ id: z.string(), name: z.string(), version: z.string().nullable() })),
});

/** Through the chat module (`chat:write`): a member without `skills:read` sees them too. */
export async function fetchEnforcedSkills(
  getHeaders: GetHeaders | null | undefined,
): Promise<SkillHint[]> {
  const res = await fetch("/api/chat/enforced-skills", {
    credentials: "include",
    headers: { ...getHeaders?.() },
  });
  if (!res.ok) throw new Error(`Failed to load the enforced skills (HTTP ${res.status})`);
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

/** Pin/unpin. The picker disables a new pin at the cap; the route refuses one past it. */
export function togglePinned(pinned: readonly string[], packageId: string): string[] {
  return pinned.includes(packageId)
    ? pinned.filter((id) => id !== packageId)
    : [...pinned, packageId];
}

/**
 * A choosable picker row: the catalogue, then every pin missing from it
 * (`available: false`), so a dead pin can still be removed. Enforced skills are
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
    ...dead.map((id) => ({ skill: { packageId: id }, available: false })),
  ];
}
