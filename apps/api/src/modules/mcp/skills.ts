// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP Skills extension (SEP-2640) of the spaces a connection reaches (the
 * space it entered, or every space of an org-wide connection): `skills/list`,
 * `skills/get` and `resources/read` on `skill://`. Every read goes through
 * `services/skill-read.ts`, the rule `read_skill` applies, with the caller's
 * permissions in the skill's space: a skill the chat turn injected is readable
 * at the definition injected, any other needs `skills:read` there (under the
 * credential's ceiling).
 *
 * `skills/list` holds the published definition of each active skill, in each
 * space reached, that the caller may read and the server can serve whole. A draft is never listed: it is read
 * by its `@draft` URI through `skills/get` and `resources/read`. Whatever is
 * listed is readable; a skill over the limits of `./skill-resources.ts` is
 * absent, refused by `skills/get` and `resources/read`, and logged.
 */

import { ErrorCode, McpError, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateSkillProvider, SkillEntry } from "@appstrate/mcp-transport";
import { ApiError } from "../../lib/errors.ts";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import type { SkillDefinitionSelector, SkillSnapshot } from "../../services/skill-read.ts";
import {
  parseSkillUri,
  serveSkill,
  SKILL_ENTRY,
  skillEntry,
  type ServedSkill,
  type SkillAddress,
} from "./skill-resources.ts";
import { RESOURCE_NOT_FOUND_ERROR_CODE } from "./tools.ts";

/** Snapshot reads `skills/list` runs at once. */
const LIST_CONCURRENCY = 8;

export interface SkillProviderContext {
  /** The spaces the connection reaches, in listing order. */
  spaceIds: readonly string[];
  /** Ids of the published skills active in a space. */
  listActiveSkillIds: (spaceId: string) => Promise<string[]>;
  /** `readSkillSnapshot` in a space, bound to the request; `null` or an `ApiError` when refused. */
  readSkill: (
    spaceId: string,
    packageId: string,
    definition: SkillDefinitionSelector,
  ) => Promise<SkillSnapshot | null>;
  /** A skill the server refuses to serve, with the reason. */
  logUnservable: (event: {
    spaceId: string;
    packageId: string;
    definition: SkillDefinitionSelector;
    reason: string;
  }) => void;
}

type Served = { skill: ServedSkill; address: Omit<SkillAddress, "name" | "path"> };

export interface SkillServer {
  provider: AppstrateSkillProvider;
  /** `resources/read` of a `skill://` URI. */
  read: (uri: string) => Promise<ReadResourceResult>;
}

/** Bytes the round trip through a JSON string keeps exactly: UTF-8 without a BOM to strip. */
function exactText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
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
    let snapshot: SkillSnapshot | null;
    try {
      snapshot = await ctx.readSkill(spaceId, packageId, definition);
    } catch (err) {
      if (err instanceof ApiError) return null;
      throw err;
    }
    if (!snapshot || snapshot.definition !== definition) return null;
    const served = serveSkill(packageId, snapshot.snapshot.files);
    if (!served.ok) {
      ctx.logUnservable({ spaceId, packageId, definition, reason: served.reason });
      return null;
    }
    return { skill: served.skill, address: { spaceId, packageId, definition } };
  }

  /** The skill a URI of a reached space names, with the served name it carries. */
  async function resolve(address: SkillAddress | null): Promise<Served | null> {
    if (!address || !ctx.spaceIds.includes(address.spaceId)) return null;
    const served = await load(address.spaceId, address.packageId, address.definition);
    return served?.skill.name === address.name ? served : null;
  }

  const provider: AppstrateSkillProvider = {
    list: async () => {
      const listed = await Promise.all(
        ctx.spaceIds.map(async (spaceId) =>
          (await ctx.listActiveSkillIds(spaceId)).map((packageId) => ({ spaceId, packageId })),
        ),
      );
      const loaded = await mapWithConcurrency(listed.flat(), LIST_CONCURRENCY, (skill) =>
        load(skill.spaceId, skill.packageId, "published"),
      );
      return loaded
        .filter((served): served is Served => served !== null)
        .map((served): SkillEntry => skillEntry(served.address, served.skill));
    },
    get: async (uri) => {
      const address = parseSkillUri(uri);
      const served = address?.path === SKILL_ENTRY ? await resolve(address) : null;
      if (!served) {
        throw new McpError(ErrorCode.InvalidParams, `No skill readable at ${uri}`, { uri });
      }
      return skillEntry(served.address, served.skill);
    },
  };

  const read = async (uri: string): Promise<ReadResourceResult> => {
    const address = parseSkillUri(uri);
    const served = await resolve(address);
    const bytes = served && address ? served.skill.files[address.path] : undefined;
    if (!bytes) {
      throw new McpError(RESOURCE_NOT_FOUND_ERROR_CODE, "Resource not found", { uri });
    }
    const text = exactText(bytes);
    const mimeType = address!.path.endsWith(".md") ? "text/markdown" : "text/plain";
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

  return { provider, read };
}
