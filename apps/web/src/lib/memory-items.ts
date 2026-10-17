// SPDX-License-Identifier: Apache-2.0

import type { PersistenceActorType } from "@appstrate/shared-types";
import { matchesSearch } from "./strings";

/** A memory's content as text: a string as written, anything else as indented JSON. */
export function memoryText(content: unknown): string {
  return typeof content === "string"
    ? content
    : (JSON.stringify(content, null, 2) ?? String(content));
}

export type MemoryScope = "shared" | "mine" | "others";

/**
 * Whose a row is, seen from the signed-in user: `shared`, the user's own
 * (`actor_type: "user"` with their id), or another actor's — which a caller
 * holding `persistence:delete` also reads.
 */
export function memoryScopeOf(
  item: { actor_type: PersistenceActorType; actor_id: string | null },
  userId: string | undefined,
): MemoryScope {
  if (item.actor_type === "shared") return "shared";
  return item.actor_type === "user" && item.actor_id === userId ? "mine" : "others";
}

/** The toolbar's filters: `scopes` holds `MemoryScope`s, `types` the tiers; an empty list keeps all. */
export function filterMemoryItems<
  T extends {
    kind: "pinned" | "archive";
    key: string | null;
    content: unknown;
    actor_type: PersistenceActorType;
    actor_id: string | null;
  },
>(
  items: readonly T[],
  filter: { query: string; scopes: string[]; types: string[] },
  userId: string | undefined,
): T[] {
  return items.filter((item) => {
    const scope = memoryScopeOf(item, userId);
    const scopeMatches = filter.scopes.length === 0 || filter.scopes.includes(scope);
    const typeMatches = filter.types.length === 0 || filter.types.includes(item.kind);
    return (
      scopeMatches &&
      typeMatches &&
      matchesSearch(filter.query, [item.key, memoryText(item.content)])
    );
  });
}
