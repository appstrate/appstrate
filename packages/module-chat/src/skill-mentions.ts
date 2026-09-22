// SPDX-License-Identifier: Apache-2.0

/**
 * `/skill` mentions. Directive `:skill[label]{name=@scope/name}` persisted raw;
 * the body is projected into the turn text on every turn (cache-safe). Bodies
 * are re-read every turn, so an edited or revoked skill changes a block of
 * history that was already answered — accepted, because the persisted text must
 * stay the directive. The UI bundles this file: runtime imports stay browser-safe.
 */

import type { UIMessage } from "ai";
import type { Logger } from "@appstrate/core/logger";
import { encodePackageIdPath } from "@appstrate/core/naming";
import { scopedNameRegex } from "@appstrate/core/validation";
import type { ChatPlatformDeps } from "./platform-services.ts";

/** ~8k tokens: a generous SKILL.md that still cannot eat the conversation. */
export const MAX_SKILL_BODY_BYTES = 32 * 1024;

export const SKILL_TRUNCATION_MARKER = "\n[… truncated]";

/** Every loaded body is replayed on every later turn, so this bounds the history. */
export const MAX_MENTIONED_SKILLS = 10;

export const TOO_MANY_SKILLS_REASON = "too many skills mentioned in one conversation";

const UNREADABLE_REASON = "the skill could not be read";
const UNKNOWN_REASON = "not resolved for this turn";

export interface LoadedSkillBody {
  package_id: string;
  version: string | null;
  /** Uncapped; {@link messagesWithSkillsAsText} caps it. */
  body: string;
}

export interface LoadedSkillError {
  package_id: string;
  error: string;
}

export type LoadedSkill = LoadedSkillBody | LoadedSkillError;

// Finds candidates only; `scopedNameRegex` decides, so the two cannot drift.
const SKILL_DIRECTIVE_RE = /:skill\[([^\]\n]{1,1024})\]\{name=(@[a-z0-9-]+\/[a-z0-9-]+)\}/g;

export interface SkillMention {
  id: string;
  label: string;
  /** Exact source text, for replacement in place. */
  raw: string;
  index: number;
}

export function parseSkillMentions(text: string): SkillMention[] {
  const out: SkillMention[] = [];
  const re = new RegExp(SKILL_DIRECTIVE_RE.source, "g");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const id = m[2]!;
    if (!scopedNameRegex.test(id)) continue;
    out.push({ id, label: m[1]!, raw: m[0]!, index: m.index });
  }
  return out;
}

export type SkillTextSegment =
  { kind: "text"; text: string } | { kind: "skill"; label: string; id: string };

/** Shared by the bubble chips and the session title, so both cut where the server parses. */
export function splitSkillDirectives(text: string): SkillTextSegment[] {
  const out: SkillTextSegment[] = [];
  let cursor = 0;
  for (const mention of parseSkillMentions(text)) {
    if (mention.index > cursor) out.push({ kind: "text", text: text.slice(cursor, mention.index) });
    out.push({ kind: "skill", label: mention.label, id: mention.id });
    cursor = mention.index + mention.raw.length;
  }
  if (cursor < text.length) out.push({ kind: "text", text: text.slice(cursor) });
  return out;
}

function textParts(message: UIMessage): { text: string }[] {
  return (message.parts ?? []).flatMap((part) =>
    part.type === "text" ? [part as { text: string }] : [],
  );
}

/** Ids mentioned by every user message of the branch, deduped, in first-appearance order. */
export function mentionedSkillIds(messages: UIMessage[]): string[] {
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of textParts(message)) {
      for (const mention of parseSkillMentions(part.text)) seen.add(mention.id);
    }
  }
  return [...seen];
}

/** The problem's stable `code`, else its `title`, else the bare status. */
async function refusalReason(res: Response): Promise<string> {
  try {
    const problem = (await res.json()) as { code?: unknown; title?: unknown };
    if (typeof problem?.code === "string" && problem.code) return problem.code;
    if (typeof problem?.title === "string" && problem.title) return problem.title;
  } catch {
    // Not a problem document.
  }
  return `HTTP ${res.status}`;
}

/**
 * Read each SKILL.md through the route `getSkill` serves, with the caller's own
 * headers, so a mention is authorized as a load is. Never throws.
 */
export async function loadMentionedSkills(
  deps: Pick<ChatPlatformDeps, "dispatch">,
  args: { origin: string; headers: Headers; log: Pick<Logger, "warn"> },
  ids: readonly string[],
): Promise<Map<string, LoadedSkill>> {
  const distinct = [...new Set(ids)];
  const loaded = await Promise.all(
    distinct.slice(0, MAX_MENTIONED_SKILLS).map(async (id): Promise<LoadedSkill> => {
      try {
        const url = new URL(`/api/packages/skills/${encodePackageIdPath(id)}`, args.origin);
        const res = await deps.dispatch(new Request(url.toString(), { headers: args.headers }));
        if (!res.ok) return { package_id: id, error: await refusalReason(res) };
        const detail = (await res.json()) as { content?: unknown; version?: unknown };
        const body = typeof detail?.content === "string" ? detail.content : "";
        if (!body) return { package_id: id, error: "the skill has no content" };
        const version = typeof detail.version === "string" ? detail.version : null;
        return { package_id: id, version, body };
      } catch (err) {
        args.log.warn("chat skill mention could not be read", { skill: id, err: String(err) });
        return { package_id: id, error: UNREADABLE_REASON };
      }
    }),
  );

  const out = new Map<string, LoadedSkill>();
  for (const skill of loaded) out.set(skill.package_id, skill);
  for (const id of distinct.slice(MAX_MENTIONED_SKILLS)) {
    out.set(id, { package_id: id, error: TOO_MANY_SKILLS_REASON });
  }
  return out;
}

function capBody(body: string): string {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= MAX_SKILL_BODY_BYTES) return body;
  // A mid-sequence cut decodes to a trailing U+FFFD; dropping it lands on a character.
  const head = new TextDecoder().decode(bytes.slice(0, MAX_SKILL_BODY_BYTES)).replace(/�$/, "");
  return `${head}${SKILL_TRUNCATION_MARKER}`;
}

function loadedBlock(skill: LoadedSkillBody): string {
  const version = skill.version ? ` (v${skill.version})` : "";
  return `[Skill ${skill.package_id}${version} loaded — follow these instructions]\n${capBody(skill.body)}`;
}

/**
 * Each directive of a USER message replaced by its model-facing block: the body
 * at an id's first appearance, a back-reference afterwards, a reason when it
 * could not be read. `seen` follows message order, never loader order.
 */
export function messagesWithSkillsAsText(
  messages: UIMessage[],
  loaded: ReadonlyMap<string, LoadedSkill>,
): UIMessage[] {
  const seen = new Set<string>();
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const parts = message.parts;
    if (!parts?.some((part) => part.type === "text" && parseSkillMentions(part.text).length > 0)) {
      return message;
    }
    return {
      ...message,
      parts: parts.map((part) => {
        if (part.type !== "text") return part;
        const mentions = parseSkillMentions(part.text);
        if (mentions.length === 0) return part;
        let text = "";
        let cursor = 0;
        for (const mention of mentions) {
          text += part.text.slice(cursor, mention.index);
          const skill = loaded.get(mention.id);
          if (!skill || "error" in skill) {
            // Repeated at every mention: there is no body above to point back to.
            const reason = skill ? skill.error : UNKNOWN_REASON;
            text += `[Skill ${mention.id} could not be loaded: ${reason}]`;
          } else if (seen.has(mention.id)) {
            text += `[Skill ${mention.id} already loaded above]`;
          } else {
            seen.add(mention.id);
            text += loadedBlock(skill);
          }
          cursor = mention.index + mention.raw.length;
        }
        text += part.text.slice(cursor);
        return { ...part, text };
      }),
    };
  });
}
