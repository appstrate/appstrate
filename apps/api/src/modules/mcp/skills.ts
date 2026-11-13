// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP Skills extension (SEP-2640) of the spaces a connection reaches (the
 * space it entered, or every space of an org-wide connection): `skills/list`,
 * `skills/get` and `resources/read` on `skill://`, over the skills
 * `services/served-skills.ts` serves — the function the package routes of
 * `appstrate code sync` serve too, so both surfaces serve the same entries and
 * the same bytes.
 *
 * `skills/list` holds the published entries; with the request `_meta`
 * `dev.appstrate/definition: "draft"`, it holds the drafts instead, at their
 * `@draft` URIs: the list `GET /api/packages/skills/served?definition=draft`
 * serves. A changed injected draft is refused with its own error, never as a
 * not-found.
 */

import { ErrorCode, McpError, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateSkillProvider } from "@appstrate/mcp-transport";
import { SKILL_DEFINITION_META_KEY } from "@appstrate/core/skill-uri";
import type { SkillDefinitionSelector } from "../../services/skill-read.ts";
import {
  buildServedSkills,
  isInjectedDraftChanged,
  type ServedSkills,
  type ServedSkillsContext,
} from "../../services/served-skills.ts";
import { RESOURCE_NOT_FOUND_ERROR_CODE } from "./tools.ts";

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

export interface SkillServer extends ServedSkills {
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

/** The read `read`, with a changed injected draft as an MCP `InvalidRequest` naming its code. */
async function explained<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (isInjectedDraftChanged(err)) {
      throw new McpError(ErrorCode.InvalidRequest, err.message, { code: err.code });
    }
    throw err;
  }
}

export function buildSkillServer(ctx: ServedSkillsContext): SkillServer {
  const served = buildServedSkills(ctx);

  const provider: AppstrateSkillProvider = {
    list: (extra) => served.list(listedDefinition(extra._meta)),
    get: async (uri) => {
      const found = await explained(() => served.entry(uri));
      if (!found) {
        throw new McpError(ErrorCode.InvalidParams, `No skill readable at ${uri}`, { uri });
      }
      return found;
    },
  };

  const read = async (uri: string): Promise<ReadResourceResult> => {
    const bytes = await explained(() => served.file(uri));
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

  return { ...served, provider, read };
}
