// SPDX-License-Identifier: Apache-2.0

/**
 * The skills and agents a user message names, in assistant-ui's directive syntax
 * (`:skill[label]{name=@scope/name}`, `:agent[title]{name=run-…}`), parsed by the formatter the
 * composer draws its chips with, so browser and server read the same text.
 */

import { defaultDirectiveFormatter } from "@assistant-ui/core";

export const SKILL_DIRECTIVE = "skill";
export const AGENT_DIRECTIVE = "agent";

export interface Directive {
  type: typeof SKILL_DIRECTIVE | typeof AGENT_DIRECTIVE;
  /** The skill's name, or the agent's title. */
  label: string;
  /** The skill's package id (`@scope/name`), or the agent's prompt name (`run-…`). */
  id: string;
}

type TextSegment = { kind: "text"; text: string } | ({ kind: "directive" } & Directive);

function isKnown(type: string): type is Directive["type"] {
  return type === SKILL_DIRECTIVE || type === AGENT_DIRECTIVE;
}

export function serializeDirective(directive: Directive): string {
  return defaultDirectiveFormatter.serialize(directive);
}

/** `text` in order: literal text, and the skill and agent directives in it. Any other `:type[…]` stays text. */
export function directiveSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const push = (segment: TextSegment) => {
    const last = segments[segments.length - 1];
    if (segment.kind === "text" && last?.kind === "text") last.text += segment.text;
    else segments.push(segment);
  };
  for (const segment of defaultDirectiveFormatter.parse(text)) {
    if (segment.kind === "text") push(segment);
    else if (isKnown(segment.type)) {
      push({ kind: "directive", type: segment.type, label: segment.label, id: segment.id });
    } else push({ kind: "text", text: defaultDirectiveFormatter.serialize(segment) });
  }
  return segments;
}

export function directivesOf(text: string): Directive[] {
  return directiveSegments(text).flatMap((segment) =>
    segment.kind === "directive"
      ? [{ type: segment.type, label: segment.label, id: segment.id }]
      : [],
  );
}

/** `text` as read by a person or the model: directives become `/label` (agents dropped with `omitAgent`). */
export function readableDirectives(text: string, { omitAgent = false } = {}): string {
  return directiveSegments(text)
    .map((segment) =>
      segment.kind === "text"
        ? segment.text
        : omitAgent && segment.type === AGENT_DIRECTIVE
          ? ""
          : `/${segment.label}`,
    )
    .join("");
}
