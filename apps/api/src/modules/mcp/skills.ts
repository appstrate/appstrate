// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP Skills extension (SEP-2640) of the space a request entered:
 * `skills/list`, `skills/get` and `resources/read` on `skill://`. Every read
 * goes through `services/skill-read.ts`, the rule `read_skill` applies: a skill
 * the chat turn injected is readable at the definition injected, any other
 * needs `skills:read` (under the credential's ceiling).
 *
 * `skills/list` holds the published definition of each active skill the caller
 * may read and the server can serve whole. A draft is never listed: it is read
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
  spaceId: string;
  /** Ids of the published skills active in the space. */
  listActiveSkillIds: () => Promise<string[]>;
  /** `readSkillSnapshot` bound to the request; `null` or an `ApiError` when refused. */
  readSkill: (
    packageId: string,
    definition: SkillDefinitionSelector,
  ) => Promise<SkillSnapshot | null>;
  /** A skill the server refuses to serve, with the reason. */
  logUnservable: (event: {
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
    packageId: string,
    definition: SkillDefinitionSelector,
  ): Promise<Served | null> {
    let snapshot: SkillSnapshot | null;
    try {
      snapshot = await ctx.readSkill(packageId, definition);
    } catch (err) {
      if (err instanceof ApiError) return null;
      throw err;
    }
    if (!snapshot || snapshot.definition !== definition) return null;
    const served = serveSkill(packageId, snapshot.snapshot.files);
    if (!served.ok) {
      ctx.logUnservable({ packageId, definition, reason: served.reason });
      return null;
    }
    return { skill: served.skill, address: { spaceId: ctx.spaceId, packageId, definition } };
  }

  /** The skill a URI of this space names, with the served name it carries. */
  async function resolve(address: SkillAddress | null): Promise<Served | null> {
    if (!address || address.spaceId !== ctx.spaceId) return null;
    const served = await load(address.packageId, address.definition);
    return served?.skill.name === address.name ? served : null;
  }

  const provider: AppstrateSkillProvider = {
    list: async () => {
      const ids = await ctx.listActiveSkillIds();
      const loaded = await mapWithConcurrency(ids, LIST_CONCURRENCY, (id) => load(id, "published"));
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
