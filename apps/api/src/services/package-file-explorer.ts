// SPDX-License-Identifier: Apache-2.0

// Which package, and which definition of it, a file-explorer read serves —
// one answer for the files routes, the detail page and MCP `read_skill`.
// Authorization (`<type>:read`) stays with each caller.

import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import {
  assertDraftSelectorAllowed,
  defaultDefinitionSelector,
  isPackageReadableInSpace,
} from "../lib/package-access.ts";
import { VERSION_SELECTOR_DRAFT } from "./agent-version-resolver.ts";
import type { PackageFileSource } from "./package-files.ts";

/**
 * The file-explorer row: a {@link PackageFileSource} plus the `source` column,
 * which is what tells a platform-shipped definition from an org-authored one.
 */
export type FileExplorerPackage = PackageFileSource & { source: string };

/** Visibility only: `null` when not reachable from this space or not in the org. */
export async function findFileExplorerPackage(
  scope: SpaceScope,
  packageId: string,
): Promise<FileExplorerPackage | null> {
  if (!(await isPackageReadableInSpace(scope.spaceId, packageId))) return null;
  const [pkg] = await db
    .select({
      id: packages.id,
      type: packages.type,
      source: packages.source,
      orgId: packages.orgId,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
    })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(scope.orgId), notEphemeralFilter()))
    .limit(1);
  return pkg ?? null;
}

/**
 * WHICH definition a file-explorer read renders — the same question the agent
 * detail page answers, from the same two functions, because they are the same
 * question (RBAC spec §6.10).
 *
 * Reading is not executing, so an omitted `?version` gets the definition that
 * EXISTS for this caller: the author's draft when they may write the package,
 * the latest published version otherwise, and the draft again when nothing is
 * published — a readable package whose explorer 404s is a tab the detail page
 * has just promised and cannot honour. That is {@link defaultDefinitionSelector},
 * verbatim, mapped onto the version-spec vocabulary these two routes speak:
 * `undefined` is their word for the draft and `latest` for the published tag.
 *
 * An EXPLICIT `?version=draft` is the other act, and keeps the other rule:
 * naming the working copy is an author's move, refused with
 * `403 draft_not_writable` ({@link assertDraftSelectorAllowed}). Without it
 * these two routes would be a fifth door to a draft the run, the schedule, the
 * readiness and the bundle export all close.
 *
 * A system package ships its definition with the platform and owns no
 * `package_versions` rows, so `latest` would resolve to nothing: its stored
 * tree IS its published definition, and every selector but the named `draft`
 * reads it. Same rule the run path applies (`resolveAgentRunVersion` ignores
 * the selector for `source === "system"`), stated here rather than inherited
 * because the 404 it prevents shows up only on a system package's Files tab.
 *
 * Takes the two columns it reads rather than a whole row, because the DETAIL
 * projection asks the same question from a different query
 * (`buildPackageDetailDto`) and must get it from this function rather than
 * from a second spelling of it.
 */
export async function resolveFileExplorerVersion(
  c: Context<AppEnv>,
  pkg: Pick<FileExplorerPackage, "id" | "source">,
  explicit: string | undefined,
): Promise<string | undefined> {
  await assertDraftSelectorAllowed(c, pkg.id, explicit);
  if (pkg.source === "system") return undefined;
  if (explicit) return explicit;
  const { selector } = await defaultDefinitionSelector(c, pkg);
  return selector === VERSION_SELECTOR_DRAFT ? undefined : "latest";
}

/** Whether a version spec renders the stored tree (omitted, or the literal `draft`). */
export function rendersStoredTree(
  spec: string | undefined,
): spec is undefined | typeof VERSION_SELECTOR_DRAFT {
  return spec === undefined || spec === VERSION_SELECTOR_DRAFT;
}

/**
 * `definition` on the wire. A system package's stored tree is what the platform
 * ships, published by construction — never labelled `draft`.
 */
export function servedDefinition(
  pkg: Pick<FileExplorerPackage, "source">,
  spec: string | undefined,
): "draft" | "published" {
  return rendersStoredTree(spec) && pkg.source !== "system" ? "draft" : "published";
}
