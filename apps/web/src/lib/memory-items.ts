// SPDX-License-Identifier: Apache-2.0

import type { PersistenceActorType } from "@appstrate/shared-types";
import { matchesSearch } from "./strings";

/** A memory's content as text: a string as written, anything else as indented JSON. */
export function memoryText(content: unknown): string {
  return typeof content === "string"
    ? content
    : (JSON.stringify(content, null, 2) ?? String(content));
}

/** The toolbar's filters: `scopes` holds "shared" | "mine", `types` the tiers; an empty list keeps all. */
export function filterMemoryItems<
  T extends {
    kind: "pinned" | "archive";
    key: string | null;
    content: unknown;
    actor_type: PersistenceActorType;
  },
>(items: readonly T[], filter: { query: string; scopes: string[]; types: string[] }): T[] {
  return items.filter((item) => {
    const scope = item.actor_type === "shared" ? "shared" : "mine";
    const scopeMatches = filter.scopes.length === 0 || filter.scopes.includes(scope);
    const typeMatches = filter.types.length === 0 || filter.types.includes(item.kind);
    return (
      scopeMatches &&
      typeMatches &&
      matchesSearch(filter.query, [item.key, memoryText(item.content)])
    );
  });
}
