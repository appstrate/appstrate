// SPDX-License-Identifier: Apache-2.0

/** The slice of a catalog entry the scope counter reads. */
interface ScopedTool {
  /** Absent: a catalog without a verdict, whose tools all count as usable. */
  status?: string;
  policy?: { required_scopes?: Readonly<Record<string, readonly string[]>> };
}

/**
 * How many usable tools of an OAuth integration ask for no scope: their grant is unknown, so a
 * connection made for them may be refused upstream. Only tools an agent can call count.
 */
export function countToolsWithoutScopes(catalog: readonly ScopedTool[]): number {
  return catalog.filter(
    (tool) =>
      (tool.status ?? "available") === "available" &&
      Object.values(tool.policy?.required_scopes ?? {}).every((scopes) => scopes.length === 0),
  ).length;
}
