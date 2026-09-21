// SPDX-License-Identifier: Apache-2.0

/**
 * Which workspace modules a compose file turns ON BY DEFAULT — the `MODULES`
 * value an operator gets when they set nothing.
 *
 * Two gates ask this question and must not answer it differently:
 * `verify-env-docs.ts` decides whether a shipped `.env.example` has to carry a
 * module's hard-required keys, and `verify-compose-defaults.ts` decides whether
 * a compose file that forwards none of a module's variables is out of scope or
 * broken. Both answers turn on the same fact, so it is derived once here.
 *
 * ─── Why this is not a constant ──────────────────────────────────────
 *
 * Every gate in this directory used to treat "modules are opt-in via `MODULES`"
 * as universally true, and it was, while every compose file in the repository
 * passed `MODULES` straight through from the environment. `deploy/` broke that:
 * it pins a default that names a module, so for the example file beside it the
 * module's keys are not optional at all. A hand-kept list of "the files where
 * billing is on" would have to be remembered by whoever adds the next such
 * file — which is the failure this reads the file to avoid.
 *
 * The specifier → package mapping is structural on purpose: a platform file
 * under Apache-2.0 may not name a module in a literal specifier
 * (`verify-module-isolation.ts`), and it does not need to.
 */

/**
 * `MODULES` declared in a compose file, in either of the two forms compose
 * accepts — a list entry (`- MODULES=…`) or a mapping (`MODULES: …`). Anchored
 * past leading whitespace, so a `#` comment mentioning the name never matches.
 */
const MODULES_ASSIGNMENT = /^[ \t]*(?:-[ \t]*MODULES=|MODULES:[ \t]+)(.*)$/m;

/** `${MODULES}` or `${MODULES:-a,b,c}` — the interpolation, and its default if it has one. */
const MODULES_INTERPOLATION = /^\$\{MODULES(?::-(.*))?\}$/;

/** A workspace module's directory is `packages/module-<id>`; its specifier ends the same way. */
const MODULE_PACKAGE_PREFIX = "module-";

/**
 * The `MODULES` value this file falls back to when the environment is silent,
 * or `null` when it supplies none.
 *
 * `null` covers the three ways a file declines to answer, which are all the
 * same answer: it does not declare `MODULES` at all, it passes the variable
 * through bare (`- MODULES`), or it interpolates with no default
 * (`${MODULES}`). A value still carrying an unresolved `${…}` is `null` too —
 * the gates read this to decide what is REQUIRED, and half a value would let
 * them require the wrong thing.
 */
export function defaultModulesValue(content: string): string | null {
  const match = MODULES_ASSIGNMENT.exec(content);
  if (!match) return null;

  const raw = match[1]!.trim().replace(/^["']|["']$/g, "");
  const interpolated = MODULES_INTERPOLATION.exec(raw);
  const value = interpolated ? (interpolated[1] ?? "") : raw;

  if (value === "" || value.includes("${")) return null;
  return value;
}

/**
 * The ids of the workspace modules that value names — `ee` for a specifier
 * ending `module-ee`, matching `packages/module-*` as `module-env-schemas.ts`
 * reads it.
 *
 * A specifier whose last segment does not start with `module-` is a built-in
 * (`oidc`, `webhooks`, `mcp`, …): there is no package behind it and no env
 * schema to demand anything from. Skipped rather than reported, because a
 * built-in in this list is the normal case, not a finding.
 */
export function modulesEnabledByDefault(content: string): string[] {
  const value = defaultModulesValue(content);
  if (value === null) return [];

  const ids: string[] = [];
  for (const entry of value.split(",")) {
    const specifier = entry.trim();
    const tail = specifier.slice(specifier.lastIndexOf("/") + 1);
    if (!tail.startsWith(MODULE_PACKAGE_PREFIX)) continue;
    const id = tail.slice(MODULE_PACKAGE_PREFIX.length);
    if (id !== "" && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The compose file that ships beside an `.env.example` — same directory, the
 * canonical name.
 *
 * The coupling is the directory: an operator who copies `deploy/.env.example`
 * to `deploy/.env` runs `deploy/docker-compose.yml` with it, and that file is
 * what decides which modules boot. The tier variants beside a
 * `docker-compose.yml` are alternatives to it, not additional contracts, so the
 * canonical name is the one asked.
 */
export function siblingComposeFile(envExamplePath: string): string {
  const slash = envExamplePath.lastIndexOf("/");
  const directory = slash === -1 ? "" : envExamplePath.slice(0, slash + 1);
  return `${directory}docker-compose.yml`;
}
