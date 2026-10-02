// SPDX-License-Identifier: Apache-2.0

// `read_skill`. It neither dispatches to REST nor reuses a REST guard: a skill
// the chat turn injected is readable without `skills:*`, so its rule is its own
// (`services/skill-read.ts`); REST RBAC is unchanged.

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, EmbeddedResource, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";
import { ApiError, notFound } from "../../lib/errors.ts";
import { classifyPackageFile, snapshotFile } from "../../services/package-files.ts";
import { readSkillSnapshot, type SkillSnapshot } from "../../services/skill-read.ts";
import { VERSION_SELECTOR_DRAFT } from "../../services/agent-version-resolver.ts";
import { assertPermission } from "../../middleware/require-permission.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import type { AppEnv } from "../../types/index.ts";
import { asString, RESOURCE_BLOB_MAX_BYTES, jsonResult } from "./tool-results.ts";

export interface SkillToolContext {
  readSkill: (packageId: string) => Promise<SkillSnapshot>;
  /** Public origin — a binary file's embedded resource names its REST content URL. */
  origin: string;
  requestId: string;
  observe: (event: { tool: "read_skill"; durationMs: number; status: number }) => void;
}

/** `readSkillSnapshot` bound to the request, its refusal answered as REST answers it. */
export function skillReaderFor(
  c: Context<AppEnv>,
  scope: SpaceScope,
): SkillToolContext["readSkill"] {
  return async (packageId) => {
    const skill = await readSkillSnapshot(c, scope, packageId);
    if (skill) return skill;
    // The route guard's 403 (with its denial audit) comes before any lookup.
    assertPermission(c, "skills", "read");
    throw notFound(`Skill '${packageId}' not found`);
  };
}

const SKILL_ENTRY = PACKAGE_CONTENT_ENTRY.skill!.path;
const OVERSIZED_NOTE = "Content omitted — it exceeds the inline size limit.";

/**
 * The `GET …/files/content` URL serving `path` of the definition read. A draft is named
 * `version=draft`: omitted, the route serves the latest published version to a non-author.
 * A system package's tree takes no selector.
 */
function fileContentUrl(origin: string, skill: SkillSnapshot, path: string): string {
  const url = new URL(`/api/packages/${skill.packageId}/files/content`, origin);
  url.searchParams.set("path", path);
  const version = skill.version ?? (skill.definition === "draft" ? VERSION_SELECTOR_DRAFT : null);
  if (version !== null) url.searchParams.set("version", version);
  return url.toString();
}

/**
 * One file, as `GET …/files/content` would serve it, inlined within the MCP
 * limits: text in the JSON, a small binary as an embedded `blob` resource.
 */
function projectFile(
  origin: string,
  skill: SkillSnapshot,
  path: string,
  bytes: Uint8Array,
): { meta: Record<string, unknown>; resource?: EmbeddedResource } {
  const { kind, text } = classifyPackageFile(path, bytes);
  const meta = { path, size: bytes.byteLength, media_kind: kind };
  if (text !== null) return { meta: { ...meta, content: text } };
  if (kind === "binary" && bytes.byteLength <= RESOURCE_BLOB_MAX_BYTES) {
    const resource: EmbeddedResource = {
      type: "resource",
      resource: {
        uri: fileContentUrl(origin, skill, path),
        mimeType: "application/octet-stream",
        blob: Buffer.from(bytes).toString("base64"),
      },
    };
    return { meta, resource };
  }
  return { meta: { ...meta, note: OVERSIZED_NOTE } };
}

export function buildReadSkillTool(ctx: SkillToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "read_skill",
    description:
      "Read a skill by id. Without `path`: its SKILL.md, its file list and the version " +
      "served. With `path`: one of those files (scripts, references) at that version. A skill " +
      "a chat turn injected is readable at the definition injected; any other needs " +
      "`skills:read`.",
    annotations: {
      title: "Read skill",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: "The skill's package id, `@scope/name`." },
        path: {
          type: "string",
          description: "A file path from the skill's `files` list, exactly as listed.",
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const start = performance.now();
    const id = asString(args.id);
    if (!id) throw new McpError(ErrorCode.InvalidParams, "id is required.");
    if (args.path !== undefined && !asString(args.path)) {
      throw new McpError(ErrorCode.InvalidParams, "path must be a non-empty string.");
    }
    const path = asString(args.path);
    const done = (status: number) =>
      ctx.observe({ tool: "read_skill", durationMs: performance.now() - start, status });
    try {
      const skill = await ctx.readSkill(id);
      const head = { id: skill.packageId, version: skill.version, definition: skill.definition };
      const { files } = skill.snapshot;
      if (path === undefined) {
        const entry = snapshotFile(skill.snapshot, SKILL_ENTRY);
        const text = entry ? classifyPackageFile(SKILL_ENTRY, entry).text : null;
        done(200);
        return jsonResult({
          ...head,
          content: text,
          ...(entry && text === null ? { note: OVERSIZED_NOTE } : {}),
          files: Object.keys(files)
            .sort()
            .map((file) => ({ path: file, size: files[file]!.byteLength })),
        });
      }
      const bytes = snapshotFile(skill.snapshot, path);
      if (!bytes) throw notFound("File not found");
      done(200);
      const { meta, resource } = projectFile(ctx.origin, skill, path, bytes);
      const result = jsonResult({ ...head, ...meta });
      return resource ? { ...result, content: [...result.content, resource] } : result;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      done(err.status);
      // The REST answer to the same read: status plus its problem body.
      return jsonResult({ status: err.status, body: err.toProblemDetail(ctx.requestId) }, true);
    }
  };
  return { descriptor, handler };
}
