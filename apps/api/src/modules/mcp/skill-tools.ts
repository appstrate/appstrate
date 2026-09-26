// SPDX-License-Identifier: Apache-2.0

// `read_skill`. It neither dispatches to REST nor reuses a REST guard: a skill
// the space ENFORCES is readable by everyone who chats there, `skills:read` or
// not, so its rule is its own (`services/skill-read.ts`) — the policy surface
// of `loadEnforcedChatSkills` and `GET /api/chat/enforced-skills`.

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";
import { ApiError, notFound } from "../../lib/errors.ts";
import { classifyPackageFile, snapshotFile } from "../../services/package-files.ts";
import { readSkillSnapshot, type SkillSnapshot } from "../../services/skill-read.ts";
import { assertPermission } from "../../middleware/require-permission.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import type { AppEnv } from "../../types/index.ts";
import { asString, RESOURCE_BLOB_MAX_BYTES, textResult } from "./tool-results.ts";

export interface SkillToolContext {
  readSkill: (packageId: string) => Promise<SkillSnapshot>;
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

/** One file, as `GET …/files/content` would serve it, inlined within the MCP limits. */
function projectFile(path: string, bytes: Uint8Array): Record<string, unknown> {
  const { kind, text } = classifyPackageFile(path, bytes);
  const base = { path, size: bytes.byteLength, media_kind: kind };
  if (text !== null) return { ...base, content: text };
  if (kind === "binary" && bytes.byteLength <= RESOURCE_BLOB_MAX_BYTES) {
    return { ...base, content_base64: Buffer.from(bytes).toString("base64") };
  }
  return { ...base, note: OVERSIZED_NOTE };
}

export function buildReadSkillTool(ctx: SkillToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "read_skill",
    description:
      "Read a skill by id, e.g. one named in your instructions. Without `path`: its SKILL.md, " +
      "its file list and the version served. With `path`: one of those files (scripts, " +
      "references) at that version. A skill enforced in this request's space is served at " +
      "its published version.",
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
        return textResult({
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
      return textResult({ ...head, ...projectFile(path, bytes) });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      done(err.status);
      // The REST answer to the same read: status plus its problem body.
      return textResult({ status: err.status, body: err.toProblemDetail(ctx.requestId) }, true);
    }
  };
  return { descriptor, handler };
}
