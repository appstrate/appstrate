// SPDX-License-Identifier: Apache-2.0

/**
 * The skills of a set of spaces as the platform serves them, for the MCP Skills
 * extension (SEP-2640) of `modules/mcp/skills.ts` and for the package routes
 * `appstrate code sync` reads (`GET /api/packages/skills/served` and
 * `GET /api/packages/skills/served/archive`): one function, so the entries and
 * the bytes both surfaces serve are the same. Every read goes through
 * `./skill-read.ts`, with the caller's permissions in the skill's space: a
 * skill the chat turn injected is readable at the definition injected, any
 * other needs `skills:read` there (under the credential's ceiling).
 *
 * The published list holds the published definition of each active skill, in
 * each space reached, that the caller may read and the server can serve whole;
 * the draft list holds the drafts the caller may read, at their `@draft` URIs.
 * A draft's entry carries, in its `_meta`, the `lock_version` of the draft its
 * files were read from (`dev.appstrate/lock_version`). Whatever is listed is
 * readable; a skill over the limits of `./served-skill.ts` is absent, refused
 * by every read, and logged.
 *
 * The served `SKILL.md` carries the package version in `metadata.version`: the
 * semver of a published definition, none for a draft.
 *
 * A published version is immutable, so the skill served for it is kept in the
 * `ServedSkillCache` of `./served-skill-cache.ts`, by space, package, version
 * and archive integrity. The access rule runs on every call, before the cache:
 * the cache holds served content only, never an access decision. A draft is
 * read on every call.
 */

import type { Context } from "hono";
import {
  parseSkillUri,
  SKILL_LOCK_VERSION_META_KEY,
  SKILL_MAX_TOTAL_BYTES,
  type SkillAddress,
  type SkillEntry,
} from "@appstrate/core/skill-uri";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { PACKAGE_MANIFEST_FILE } from "@appstrate/core/package-files";
import type { AppEnv } from "../types/index.ts";
import { ApiError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import {
  resolveSkillRead,
  type SkillDefinitionSelector,
  type SkillRead,
  type SkillReadSpace,
} from "./skill-read.ts";
import { listActivePackages } from "./space-packages.ts";
import {
  createServedSkillCache,
  servedSkillCacheKey,
  type ServedSkillCache,
} from "./served-skill-cache.ts";
import { serveSkill, SKILL_ENTRY, skillEntry, type ServedSkill } from "./served-skill.ts";

/**
 * The 409 of a draft the chat turn injected and that moved since
 * (`./skill-read.ts`): every read of it throws it, the lists leave it out.
 */
const INJECTED_DRAFT_CHANGED = "injected_draft_changed";

/** Snapshot reads a list runs at once. */
const LIST_CONCURRENCY = 8;

export interface ServedSkillsContext {
  /** The spaces reached, in listing order. */
  spaceIds: readonly string[];
  /** Ids of the skills active in a space that have `definition` (a draft, or a published version). */
  listActiveSkillIds: (spaceId: string, definition: SkillDefinitionSelector) => Promise<string[]>;
  /** `resolveSkillRead` in a space, bound to the request; `null` or an `ApiError` when refused. */
  readSkill: (
    spaceId: string,
    packageId: string,
    definition: SkillDefinitionSelector,
  ) => Promise<SkillRead | null>;
  /** The skills served for published versions, shared across requests. */
  cache: ServedSkillCache;
  /** A skill the server refuses to serve, with the reason. */
  logUnservable: (event: {
    spaceId: string;
    packageId: string;
    definition: SkillDefinitionSelector;
    reason: string;
  }) => void;
}

/** A skill served, with the draft `lock_version` it was read at (`null` outside a draft). */
type Served = {
  skill: ServedSkill;
  address: Omit<SkillAddress, "name" | "path">;
  lockVersion: number | null;
};

/** The entry of a served skill, a draft's carrying its `lock_version`. */
function servedEntry({ address, skill, lockVersion }: Served): SkillEntry {
  const entry = skillEntry(address, skill);
  return lockVersion === null
    ? entry
    : { ...entry, _meta: { [SKILL_LOCK_VERSION_META_KEY]: lockVersion } };
}

/** True for the `ApiError` of a changed injected draft. */
export function isInjectedDraftChanged(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === INJECTED_DRAFT_CHANGED;
}

export interface ServedSkills {
  /** The entries of `definition` the caller may read. */
  list: (definition: SkillDefinitionSelector) => Promise<SkillEntry[]>;
  /** The entry whose `SKILL.md` is at `uri`; `null` when none is readable there. */
  entry: (uri: string) => Promise<SkillEntry | null>;
  /** The bytes served for a `skill://` URI; `null` when none are readable there. */
  file: (uri: string) => Promise<Uint8Array | null>;
  /**
   * Every file served for the skill whose `SKILL.md` is at `uri`, by path
   * inside the skill directory; `null` when none is readable there.
   */
  skillFiles: (uri: string) => Promise<Record<string, Uint8Array> | null>;
}

/**
 * The version a definition serves: a published version's semver, else a system
 * skill's shipped manifest version; `null` for a draft.
 */
function servedVersion(read: SkillRead, files: Record<string, Uint8Array>): string | null {
  if (read.definition === "draft") return null;
  if (read.version !== null) return read.version;
  const manifest = files[PACKAGE_MANIFEST_FILE];
  if (!manifest) return null;
  try {
    const { version } = JSON.parse(new TextDecoder().decode(manifest)) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export function buildServedSkills(ctx: ServedSkillsContext): ServedSkills {
  /** The skill served at `definition`, `null` when refused, unknown or unservable. */
  async function load(
    spaceId: string,
    packageId: string,
    definition: SkillDefinitionSelector,
  ): Promise<Served | null> {
    const address = { spaceId, packageId, definition };
    try {
      const read = await ctx.readSkill(spaceId, packageId, definition);
      if (!read || read.definition !== definition) return null;
      // Only a published archive is immutable: a draft or a system skill's
      // stored tree is read on every call.
      const key =
        read.version !== null && read.integrity !== null
          ? servedSkillCacheKey(spaceId, packageId, read.version, read.integrity)
          : null;
      const cached = key === null ? undefined : ctx.cache.get(key);
      if (cached) return { skill: cached, address, lockVersion: null };
      const { files, lockVersion } = await read.readSnapshot();
      const served = serveSkill(packageId, files, servedVersion(read, files));
      if (!served.ok) {
        ctx.logUnservable({ ...address, reason: served.reason });
        return null;
      }
      if (key !== null) ctx.cache.set(key, served.skill);
      return { skill: served.skill, address, lockVersion };
    } catch (err) {
      if (isInjectedDraftChanged(err)) throw err;
      if (err instanceof ApiError) return null;
      throw err;
    }
  }

  /** The skill a URI of a reached space names, with the served name it carries. */
  async function resolve(address: SkillAddress | null): Promise<Served | null> {
    if (!address || !ctx.spaceIds.includes(address.spaceId)) return null;
    const served = await load(address.spaceId, address.packageId, address.definition);
    return served?.skill.name === address.name ? served : null;
  }

  /** The skill whose `SKILL.md` is at `uri`. */
  const resolveEntry = (uri: string): Promise<Served | null> => {
    const address = parseSkillUri(uri);
    return address?.path === SKILL_ENTRY ? resolve(address) : Promise.resolve(null);
  };

  const entry = async (uri: string): Promise<SkillEntry | null> => {
    const served = await resolveEntry(uri);
    return served ? servedEntry(served) : null;
  };

  const skillFiles = async (uri: string): Promise<Record<string, Uint8Array> | null> =>
    (await resolveEntry(uri))?.skill.files ?? null;

  const file = async (uri: string): Promise<Uint8Array | null> => {
    const address = parseSkillUri(uri);
    const served = await resolve(address);
    if (!served || !address || !Object.hasOwn(served.skill.files, address.path)) return null;
    return served.skill.files[address.path]!;
  };

  const list = async (definition: SkillDefinitionSelector): Promise<SkillEntry[]> => {
    const listed = await Promise.all(
      ctx.spaceIds.map(async (spaceId) =>
        (await ctx.listActiveSkillIds(spaceId, definition)).map((packageId) => ({
          spaceId,
          packageId,
        })),
      ),
    );
    const loaded = await mapWithConcurrency(listed.flat(), LIST_CONCURRENCY, (skill) =>
      // A changed injected draft refuses its own reads explicitly; the list leaves it out.
      load(skill.spaceId, skill.packageId, definition).catch((err: unknown) => {
        if (isInjectedDraftChanged(err)) return null;
        throw err;
      }),
    );
    return loaded.filter((served): served is Served => served !== null).map(servedEntry);
  };

  return { list, entry, file, skillFiles };
}

/**
 * The published skills served by this process, shared by every request and by
 * both surfaces: room for four skills at the SEP-2640 size limit, and for
 * hundreds of skills of a few hundred KiB, the size skills usually have.
 */
const servedSkillCache = createServedSkillCache(4 * SKILL_MAX_TOTAL_BYTES);

/** The context of the skills of `spaces`, each read with the caller's permissions in that space. */
export function servedSkillsContext(
  c: Context<AppEnv>,
  spaces: readonly SkillReadSpace[],
): ServedSkillsContext {
  const bySpace = new Map(spaces.map((space) => [space.spaceId, space]));
  return {
    spaceIds: [...bySpace.keys()],
    // Published: a system skill's stored tree, or a `latest` dist-tag. Draft: any
    // organization skill (a system skill has none).
    listActiveSkillIds: async (spaceId, definition) =>
      (await listActivePackages(bySpace.get(spaceId)!, "skill"))
        .filter((row) =>
          definition === "draft"
            ? row.source !== "system"
            : row.source === "system" || row.latestVersionId !== null,
        )
        .map((row) => row.id),
    readSkill: (spaceId, packageId, definition) =>
      resolveSkillRead(c, bySpace.get(spaceId)!, packageId, definition),
    cache: servedSkillCache,
    logUnservable: (event) =>
      logger.warn("mcp.skill_unservable", { requestId: c.get("requestId"), ...event }),
  };
}
