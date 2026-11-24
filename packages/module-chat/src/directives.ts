// SPDX-License-Identifier: Apache-2.0

/**
 * The skills and agents a user message names, in assistant-ui's directive syntax
 * (`:skill[label]{name=@scope/name}`, `:agent[title]{name=run-…}`), parsed by the formatter the
 * composer draws its chips with, so browser and server read the same text.
 */

import {
  defaultDirectiveFormatter,
  type DirectiveFormatter,
  type DirectiveSegment,
} from "@assistant-ui/core";
import { fromMarkdown } from "mdast-util-from-markdown";

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

export function serializeDirective(directive: Directive): string {
  return defaultDirectiveFormatter.serialize(directive);
}

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: readonly MarkdownNode[];
}

// The SDK decodes a mention but does not return its source span. The bracket form carries
// verbatim values; the quoted form can contain JSON escapes or braces inside either string.
function mentionEnd(
  text: string,
  start: number,
  mention: Extract<DirectiveSegment, { kind: "mention" }>,
) {
  const value = start + 1 + mention.type.length;
  if (text[value] === "[") {
    const afterLabel = value + 2 + mention.label.length;
    const name = `{name=${mention.id}}`;
    return text.startsWith(name, afterLabel) ? afterLabel + name.length : afterLabel;
  }
  const quotedFields = /\{(?:[^"}]|"(?:\\.|[^"\\])*")*\}/y;
  quotedFields.lastIndex = value;
  quotedFields.exec(text);
  return quotedFields.lastIndex;
}

/** Parse commands in prose while preserving the original Markdown source of literal examples. */
export const markdownDirectiveFormatter: DirectiveFormatter = {
  serialize: defaultDirectiveFormatter.serialize,
  parse(text) {
    if (!/:(?:skill|agent)[[{]/.test(text)) return [{ kind: "text", text }];
    const literal: [number, number][] = [];
    function visit(node: MarkdownNode) {
      if (node.type === "code" || node.type === "inlineCode" || node.type === "html") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined) literal.push([start, end]);
      } else {
        node.children?.forEach(visit);
      }
    }
    visit(fromMarkdown(text));
    // An odd number of backslashes escapes the colon. Preserve the backslashes verbatim.
    for (const match of text.matchAll(/(\\+):(?=(?:skill|agent)[[{])/g)) {
      if (match[1]!.length % 2) literal.push([match.index, match.index + match[0].length]);
    }
    literal.sort((a, b) => a[0] - b[0]);
    let at = 0;
    let range = 0;
    return defaultDirectiveFormatter.parse(text).map((part) => {
      if (part.kind === "text") {
        at += part.text.length;
        return part;
      }
      const start = at;
      at = mentionEnd(text, start, part);
      while (range < literal.length && literal[range]![1] <= start) range++;
      // Markdown inside a selected title belongs to the chip. Only its opening colon
      // decides whether the whole directive is a literal example.
      return range < literal.length && literal[range]![0] <= start
        ? { kind: "text", text: text.slice(start, at) }
        : part;
    });
  },
};

/** `text` in order: literal text, and the skill and agent directives in it. Any other `:type[…]` stays text. */
export function directiveSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const push = (segment: TextSegment) => {
    const last = segments[segments.length - 1];
    if (segment.kind === "text" && last?.kind === "text") last.text += segment.text;
    else segments.push(segment);
  };
  for (const segment of markdownDirectiveFormatter.parse(text)) {
    if (segment.kind === "text") push(segment);
    else if (segment.type === SKILL_DIRECTIVE || segment.type === AGENT_DIRECTIVE) {
      push({ kind: "directive", type: segment.type, label: segment.label, id: segment.id });
    } else push({ kind: "text", text: defaultDirectiveFormatter.serialize(segment) });
  }
  return segments;
}

export function directivesOf(text: string) {
  return directiveSegments(text).filter(
    (segment): segment is Extract<TextSegment, { kind: "directive" }> =>
      segment.kind === "directive",
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
