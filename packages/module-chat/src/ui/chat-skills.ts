// SPDX-License-Identifier: Apache-2.0

/** The skill picker's data and pure rules. */

import { z } from "zod";
import { parseScopedName } from "@appstrate/core/naming";
import { parseSkillList, type SkillHint } from "../skills.ts";
import type { ChatTransport } from "./runtime-context.ts";

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

/** Pin/unpin. The picker disables a new pin at the cap; the route refuses one past it. */
export function togglePinned(pinned: readonly string[], packageId: string): string[] {
  return pinned.includes(packageId)
    ? pinned.filter((id) => id !== packageId)
    : [...pinned, packageId];
}

/**
 * A choosable picker row: the catalogue, then every pin missing from it
 * (`available: false`, named by its package's bare name), so a dead pin can
 * still be removed.
 */
export function skillPickerRows(
  catalogue: readonly SkillHint[],
  pinned: readonly string[],
): { skill: SkillHint; available: boolean }[] {
  const listed = new Set(catalogue.map((skill) => skill.packageId));
  const dead = pinned.filter((id) => !listed.has(id));
  return [
    ...catalogue.map((skill) => ({ skill, available: true })),
    ...dead.map((id) => ({
      skill: { packageId: id, display_name: parseScopedName(id)?.name ?? id },
      available: false,
    })),
  ];
}
