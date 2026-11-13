// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP Skills extension (SEP-2640) of the spaces a connection reaches (the
 * space it entered, or every space of an org-wide connection): `skills/list`,
 * `skills/get` and `resources/read` on `skill://`. Every read goes through
 * `services/skill-read.ts`, with the caller's
 * permissions in the skill's space: a skill the chat turn injected is readable
 * at the definition injected, any other needs `skills:read` there (under the
 * credential's ceiling).
 *
 * `skills/list` holds the published definition of each active skill, in each
 * space reached, that the caller may read and the server can serve whole. With
 * the request `_meta` `dev.appstrate/definition: "draft"`, it holds the drafts
 * instead, at their `@draft` URIs: the list the REST route of
 * `./skill-routes.ts` serves with `?definition=draft`, through the same
 * `list`. A draft's entry carries, in its `_meta`, the `lock_version` of the
 * draft its files were read from (`dev.appstrate/lock_version`). Whatever is
 * listed is readable; a skill over the limits of `services/served-skill.ts` is
 * absent, refused by `skills/get` and `resources/read`, and logged.
 *
 * The served `SKILL.md` carries the package version in `metadata.version`: the
 * semver of a published definition, none for a draft.
 *
 * A published version is immutable, so the skill served for it is kept in the
 * `ServedSkillCache` of `./skill-cache.ts`, by space, package, version and
 * archive integrity. The
 * access rule runs on every call, before the cache: the cache holds served
 * content only, never an access decision. A draft is read on every call.
 */

import { ErrorCode, McpError, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateSkillProvider } from "@appstrate/mcp-transport";
import {
  parseSkillUri,
  SKILL_DEFINITION_META_KEY,
  SKILL_LOCK_VERSION_META_KEY,
  type SkillAddress,
  type SkillEntry,
} from "@appstrate/core/skill-uri";
import { ApiError } from "../../lib/errors.ts";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { PACKAGE_MANIFEST_FILE } from "@appstrate/core/package-files";
import type { SkillDefinitionSelector, SkillRead } from "../../services/skill-read.ts";
import { servedSkillCacheKey, type ServedSkillCache } from "./skill-cache.ts";
import {
  serveSkill,
  SKILL_ENTRY,
  skillEntry,
  type ServedSkill,
} from "../../services/served-skill.ts";
import { RESOURCE_NOT_FOUND_ERROR_CODE } from "./tools.ts";

/** The 409 of a draft the chat turn injected and that moved since: explained to the client, never a not-found. */
const INJECTED_DRAFT_CHANGED = "injected_draft_changed";

/** Snapshot reads `skills/list` runs at once. */
const LIST_CONCURRENCY = 8;

export interface SkillProviderContext {
  /** The spaces the connection reaches, in listing order. */
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

/** The definition a `skills/list` request names in its `_meta`; `published` when absent. */
function listedDefinition(meta: Record<string, unknown> | undefined): SkillDefinitionSelector {
  const definition = meta?.[SKILL_DEFINITION_META_KEY] ?? "published";
  if (definition !== "published" && definition !== "draft") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `\`${SKILL_DEFINITION_META_KEY}\` must be "published" or "draft"`,
    );
  }
  return definition;
}

export interface SkillServer {
  provider: AppstrateSkillProvider;
  /** `resources/read` of a `skill://` URI. */
  read: (uri: string) => Promise<ReadResourceResult>;
  /** The entries of `definition` the caller may read: `skills/list` serves the published ones. */
  list: (definition: SkillDefinitionSelector) => Promise<SkillEntry[]>;
  /**
   * Every file `resources/read` serves for the skill whose `SKILL.md` is at
   * `uri`, by path inside the skill directory; `null` when none is readable there.
   */
  skillFiles: (uri: string) => Promise<Record<string, Uint8Array> | null>;
}

/** Bytes the round trip through a JSON string keeps exactly: UTF-8 without a BOM to strip. */
function exactText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
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

export function buildSkillServer(ctx: SkillProviderContext): SkillServer {
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
      if (err instanceof ApiError && err.code === INJECTED_DRAFT_CHANGED) {
        throw new McpError(ErrorCode.InvalidRequest, err.message, { code: err.code });
      }
      if (err instanceof ApiError) return null;
      throw err;
    }
  }

  const isInjectedDraftChanged = (err: unknown): boolean =>
    err instanceof McpError &&
    (err.data as { code?: unknown } | undefined)?.code === INJECTED_DRAFT_CHANGED;

  /** The skill a URI of a reached space names, with the served name it carries. */
  async function resolve(address: SkillAddress | null): Promise<Served | null> {
    if (!address || !ctx.spaceIds.includes(address.spaceId)) return null;
    const served = await load(address.spaceId, address.packageId, address.definition);
    return served?.skill.name === address.name ? served : null;
  }

  const entry = async (uri: string): Promise<SkillEntry | null> => {
    const address = parseSkillUri(uri);
    const served = address?.path === SKILL_ENTRY ? await resolve(address) : null;
    return served ? servedEntry(served) : null;
  };

  const skillFiles = async (uri: string): Promise<Record<string, Uint8Array> | null> => {
    const address = parseSkillUri(uri);
    const served = address?.path === SKILL_ENTRY ? await resolve(address) : null;
    return served ? served.skill.files : null;
  };

  /** The bytes `resources/read` serves for a `skill://` URI, `null` when none are readable there. */
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

  const provider: AppstrateSkillProvider = {
    list: (extra) => list(listedDefinition(extra._meta)),
    get: async (uri) => {
      const found = await entry(uri);
      if (!found) {
        throw new McpError(ErrorCode.InvalidParams, `No skill readable at ${uri}`, { uri });
      }
      return found;
    },
  };

  const read = async (uri: string): Promise<ReadResourceResult> => {
    const bytes = await file(uri);
    if (!bytes) {
      throw new McpError(RESOURCE_NOT_FOUND_ERROR_CODE, "Resource not found", { uri });
    }
    const text = exactText(bytes);
    const mimeType = uri.endsWith(".md") ? "text/markdown" : "text/plain";
    return {
      contents: [
        text !== null
          ? { uri, mimeType, text }
          : {
              uri,
              mimeType: "application/octet-stream",
              blob: Buffer.from(bytes).toString("base64"),
            },
      ],
    };
  };

  return { provider, read, list, skillFiles };
}
