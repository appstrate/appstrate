// SPDX-License-Identifier: Apache-2.0

/**
 * `/skill` mentions — the DIRECT-LOAD half of the chat's skill mechanism.
 *
 * The composer writes a mention as one assistant-ui directive
 * (`unstable_defaultDirectiveFormatter`, `@assistant-ui/core`):
 *
 *     :skill[/copilot]{name=@appstrate/copilot}
 *
 * The label is what the chip shows; `name` carries the package id. That raw
 * text is what gets PERSISTED — the message is never rewritten, so the
 * transcript records what was asked, not what was resolved.
 *
 * The body enters the USER TURN TEXT, never the system prompt: the prompt is
 * one `cache_control` block (`prompt.ts`) and a 32 KiB body there would bust
 * the cached prefix on the mention turn and on every turn after it.
 *
 * So the projection below runs on EVERY turn, over the whole history, and is
 * pure GIVEN `(messages, loaded)`. The LOADER is what may change between turns:
 * bodies are re-read by design, so a mention follows the skill's current
 * definition and a revoked skill stops loading.
 */

import type { UIMessage } from "ai";
import { scopedNameRegex } from "@appstrate/core/validation";

/**
 * One skill body, capped. 32 KiB is ~8k tokens — a generous SKILL.md, and far
 * enough below a turn's context that a pathological skill cannot eat the
 * conversation. Applied here rather than in the loader: what must be bounded is
 * the model-facing serialization, and this file is where it is written.
 */
export const MAX_SKILL_BODY_BYTES = 32 * 1024;

/** Appended to a body the cap cut, so the model knows it is reading a fragment. */
export const SKILL_TRUNCATION_MARKER = "\n[… truncated]";

/** A skill whose SKILL.md was read for this turn. */
export interface LoadedSkillBody {
  package_id: string;
  /** Manifest version, `null` when the definition read declares none. */
  version: string | null;
  /** The SKILL.md content, uncapped — {@link messagesWithSkillsAsText} caps it. */
  body: string;
}

/** A skill the loader could not read, with the reason the model is shown. */
export interface LoadedSkillError {
  package_id: string;
  error: string;
}

export type LoadedSkill = LoadedSkillBody | LoadedSkillError;

/**
 * Reason for a mentioned id the loaded map does not mention at all — as opposed
 * to one it explicitly failed on, which carries its own reason.
 */
const UNKNOWN_REASON = "not resolved for this turn";

/**
 * The directive grammar, strict on both halves: type `skill` and nothing else,
 * id in the AFPS scoped-name shape. Anything else stays prose, so typing
 * `:skill[` in a sentence is safe. The id pattern is deliberately LOOSER than
 * {@link scopedNameRegex} — this finds candidates, that validator decides;
 * re-typing its anchored source here is what would let the two drift.
 */
const SKILL_DIRECTIVE_RE = /:skill\[([^\]\n]{1,1024})\]\{name=(@[a-z0-9-]+\/[a-z0-9-]+)\}/g;

/** One `/skill` mention, located in the text it was found in. */
export interface SkillMention {
  /** The package id carried by the directive's `name` attribute. */
  id: string;
  /** The directive's label — what the composer chip displays. */
  label: string;
  /** The directive's exact source text, for replacement in place. */
  raw: string;
  /** Character offset of `raw` in the text it was parsed from. */
  index: number;
}

/**
 * Every valid `skill` directive in one text part, in source order. Pure: no
 * lookups, no I/O — the UI parses user bubbles with this same function.
 */
export function parseSkillMentions(text: string): SkillMention[] {
  const out: SkillMention[] = [];
  // A fresh regex per call: `lastIndex` on a module-level /g regex is state,
  // and state here would make two identical calls disagree.
  const re = new RegExp(SKILL_DIRECTIVE_RE.source, "g");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const id = m[2]!;
    if (!scopedNameRegex.test(id)) continue;
    out.push({ id, label: m[1]!, raw: m[0]!, index: m.index });
  }
  return out;
}

/** One run of a persisted text: prose, or a directive resolved to its parts. */
export type SkillTextSegment =
  { kind: "text"; text: string } | { kind: "skill"; label: string; id: string };

/**
 * Split a persisted text on its directives; the prose runs are the literal
 * gaps between them.
 *
 * ONE home for that projection, because three consumers must agree on it: the
 * user bubble renders the segments as chips, the conversation title maps them
 * to their labels, and both have to cut the text exactly where the server's own
 * parser finds a directive.
 */
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

/** The text parts of one message, in order. */
function textParts(message: UIMessage): { text: string }[] {
  return (message.parts ?? []).flatMap((part) =>
    part.type === "text" ? [part as { text: string }] : [],
  );
}

/**
 * The union of the ids mentioned by ALL user messages of the branch, in
 * first-appearance order, deduped.
 *
 * The whole history, not just the new turn: a body must stay in the
 * conversation once it was loaded there (Claude Code semantics), and the
 * projection is rebuilt from scratch on every turn — so every turn re-resolves
 * every mention the branch ever made.
 */
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

/** Cut `body` to {@link MAX_SKILL_BODY_BYTES}, on a character boundary. */
function capBody(body: string): string {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= MAX_SKILL_BODY_BYTES) return body;
  // The byte cut can land mid-sequence; the decoder emits U+FFFD for that tail
  // and dropping it is what puts the cut back on a character boundary.
  const head = new TextDecoder().decode(bytes.slice(0, MAX_SKILL_BODY_BYTES)).replace(/�$/, "");
  return `${head}${SKILL_TRUNCATION_MARKER}`;
}

/** The model-facing block for the FIRST occurrence of a successfully loaded id. */
function loadedBlock(skill: LoadedSkillBody): string {
  const version = skill.version ? ` (v${skill.version})` : "";
  return `[Skill ${skill.package_id}${version} loaded — follow these instructions]\n${capBody(skill.body)}`;
}

/** The block for a later occurrence of an id whose body is already above. */
function alreadyLoadedBlock(id: string): string {
  return `[Skill ${id} already loaded above]`;
}

/** The block for a mention the loader could not satisfy. */
function unloadableBlock(id: string, reason: string): string {
  return `[Skill ${id} could not be loaded: ${reason}]`;
}

/**
 * Return a copy of the thread with every `skill` directive in a USER message
 * replaced by its model-facing block — the body the first time an id appears in
 * the conversation, a one-line back-reference afterwards, a reason when it
 * could not be read.
 *
 * Mirrors `messagesWithAttachmentsAsText`: same place in the pipeline
 * (`buildStructuredPiTurn`), same "return the message unchanged when there is
 * nothing to rewrite" rule, same principle that the model-facing serialization
 * of a composer affordance lives in exactly one file.
 *
 * The first/later distinction is what makes a mention idempotent across turns:
 * mentioning an already-mentioned skill costs one line, not a second copy of
 * the body. `seen` is walked in message order, so it depends on the
 * conversation and never on the order the loader happened to resolve ids in.
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
          if (!skill) {
            text += unloadableBlock(mention.id, UNKNOWN_REASON);
          } else if ("error" in skill) {
            // An unreadable skill repeats its reason at every mention: there is
            // no body above to point back to, and silence would read as loaded.
            text += unloadableBlock(mention.id, skill.error);
          } else if (seen.has(mention.id)) {
            text += alreadyLoadedBlock(mention.id);
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
