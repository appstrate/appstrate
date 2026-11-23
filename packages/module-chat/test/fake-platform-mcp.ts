// SPDX-License-Identifier: Apache-2.0

/**
 * A stateless fake of the platform MCP server, answering one JSON-RPC message per request: the
 * skills it lists (`skills/list`, drafts under the draft `_meta`) and serves (`resources/read`),
 * and the agent prompts (`prompts/list`, `prompts/get`). Any other method answers 202.
 */

import { createHash } from "node:crypto";
import { SKILL_DEFINITION_META_KEY, type SkillEntry } from "@appstrate/core/skill-uri";

export interface FakeSkill {
  space: string;
  /** `@scope/name`. */
  id: string;
  /** What `resources/read` serves; `""` when omitted. */
  text?: string;
  /** The text the listed digest is of, when it differs from `text` (an unreadable skill). */
  listedText?: string;
  /** The frontmatter `name`; the package name when omitted. */
  name?: string;
  /** The frontmatter `description`; the id when omitted. */
  description?: string;
  /** The published version; `"1.0.0"` when omitted, `null` for none. A draft has none. */
  version?: string | null;
  /** The listed size of its `SKILL.md`; the length of `text` when omitted. */
  size?: number;
}

export interface FakePlatformMcpOptions {
  skills?: FakeSkill[];
  drafts?: FakeSkill[];
  prompts?: unknown[];
  /** `prompts/list` answers a JSON-RPC error. */
  promptsFail?: boolean;
  failedSkillList?: "draft" | "published";
  /** Answers `prompts/get`: a result, or `{ error }` for a JSON-RPC error. */
  getPrompt?: (params: Record<string, unknown>) => unknown;
  /** Replaces the advertised capabilities. */
  capabilities?: Record<string, unknown>;
  /** Runs on each message, before it is answered. */
  onMethod?: (
    method: string,
    params: Record<string, unknown> | undefined,
    req: Request,
  ) => void | Promise<void>;
}

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

const packageName = (id: string) => id.split("/")[1]!;

/** The `SKILL.md` URI of `skill`, in its space, published or draft. */
export function fakeSkillUri(skill: Pick<FakeSkill, "space" | "id">, draft = false): string {
  const name = packageName(skill.id);
  return `skill://${skill.space}/${skill.id.slice(1)}${draft ? "@draft" : ""}/${name}/SKILL.md`;
}

function entryOf(skill: FakeSkill, draft: boolean): SkillEntry {
  const uri = fakeSkillUri(skill, draft);
  const text = skill.text ?? "";
  const version = draft ? null : skill.version === undefined ? "1.0.0" : skill.version;
  return {
    uri,
    frontmatter: {
      name: skill.name ?? packageName(skill.id),
      description: skill.description ?? skill.id,
      ...(version ? { metadata: { version } } : {}),
    },
    resources: [{ uri, digest: sha256(skill.listedText ?? text), size: skill.size ?? text.length }],
    ...(draft ? { _meta: { "dev.appstrate/lock_version": 1 } } : {}),
  };
}

/**
 * A dispatch answering the platform MCP server's requests as `opts` scripts them; a request to
 * any other path goes to `fallback` when one is given.
 */
export function fakePlatformMcp(
  opts: FakePlatformMcpOptions = {},
  fallback?: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  const served = [
    ...(opts.skills ?? []).map((skill) => ({ skill, uri: fakeSkillUri(skill) })),
    ...(opts.drafts ?? []).map((skill) => ({ skill, uri: fakeSkillUri(skill, true) })),
  ];
  return async (req) => {
    if (fallback && !new URL(req.url).pathname.startsWith("/api/mcp/")) return fallback(req);
    const message = (await req.json()) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    await opts.onMethod?.(message.method, message.params, req);
    const reply = (body: Record<string, unknown>) =>
      Response.json({ jsonrpc: "2.0", id: message.id, ...body });
    const result = (value: unknown) => reply({ result: value });
    switch (message.method) {
      case "initialize":
        return result({
          protocolVersion: message.params?.protocolVersion,
          capabilities: opts.capabilities ?? {
            resources: {},
            prompts: {},
            extensions: { "io.modelcontextprotocol/skills": {} },
          },
          serverInfo: { name: "fake-platform", version: "1.0.0" },
        });
      case "tools/list":
        return result({ tools: [] });
      case "skills/list": {
        const meta = message.params?._meta as Record<string, unknown> | undefined;
        const draft = meta?.[SKILL_DEFINITION_META_KEY] === "draft";
        if (opts.failedSkillList === (draft ? "draft" : "published"))
          return reply({ error: { code: -32603, message: "listing failed" } });
        return result({
          skills: ((draft ? opts.drafts : opts.skills) ?? []).map((skill) => entryOf(skill, draft)),
        });
      }
      case "resources/read": {
        const uri = message.params?.uri as string;
        const hit = served.find((candidate) => candidate.uri === uri);
        if (!hit) return reply({ error: { code: -32002, message: "Resource not found" } });
        return result({
          contents: [{ uri, mimeType: "text/markdown", text: hit.skill.text ?? "" }],
        });
      }
      case "prompts/list":
        if (opts.promptsFail) return reply({ error: { code: -32603, message: "boom" } });
        return result({ prompts: opts.prompts ?? [] });
      case "prompts/get": {
        const answer = opts.getPrompt?.(message.params ?? {}) as { error?: unknown } | undefined;
        if (!answer) return reply({ error: { code: -32602, message: "Invalid prompt name" } });
        return answer.error ? reply({ error: answer.error }) : result(answer);
      }
      default:
        return new Response(null, { status: 202 });
    }
  };
}
