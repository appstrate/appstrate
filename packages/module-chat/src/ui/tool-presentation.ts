// SPDX-License-Identifier: Apache-2.0

/**
 * A tool card drawn from the presentation the platform stamps on every result
 * (`@appstrate/core/mcp-presentation`, relayed by the engine as `result.presentation`):
 * the integration, agent or user the call acted on, and for an operation its HTTP
 * method and OpenAPI tag. The card guesses nothing from a tool name or an operation id;
 * until a result carries a presentation it shows the tool's own label.
 */

import { EyeIcon, PencilIcon, PlusIcon, Trash2Icon, ZapIcon, type LucideIcon } from "lucide-react";
import {
  toolPresentationSchema,
  type PresentationSubject,
  type ToolPresentation,
} from "@appstrate/core/mcp-presentation";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import type { ChatTranslate } from "./runtime-context.ts";

/** The presentation a tool part's result carries; `undefined` while running or when absent. */
export function presentationOf(result: unknown): ToolPresentation | undefined {
  const raw = asRecordOrNull(result)?.presentation;
  if (raw === undefined) return undefined;
  const parsed = toolPresentationSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The verb icon of an HTTP method; `undefined` for a method that names none. */
export function methodIcon(method: string | undefined): LucideIcon | undefined {
  switch (method?.toUpperCase()) {
    case "GET":
    case "HEAD":
      return EyeIcon;
    case "POST":
      return PlusIcon;
    case "PUT":
    case "PATCH":
      return PencilIcon;
    case "DELETE":
      return Trash2Icon;
    default:
      return undefined;
  }
}

/** « Lecture · Agents »: the method's verb and the operation's tag, both translated. */
export function operationLabel(p: ToolPresentation, t: ChatTranslate): string | undefined {
  if (!p.method) return undefined;
  const verb = t(`tool.verb.${p.method.toUpperCase()}`, { defaultValue: p.method.toUpperCase() });
  return p.tag ? `${verb} · ${t(`tool.tag.${p.tag}`, { defaultValue: p.tag })}` : verb;
}

/** The name a subject is shown under. */
export function subjectName(subject: PresentationSubject): string {
  return subject.display_name ?? subject.id;
}

/** Label, subject and id a card shows for one call, from its presentation. */
export interface PresentedCall {
  /** Shown verbatim; already translated. */
  label: string;
  /** What the call acted on: its glyph replaces the card's icon (`SubjectGlyph`). */
  subject?: PresentationSubject;
  /** Replaces the card's own icon when the call names its method but no subject. */
  Icon?: LucideIcon;
  idText?: string;
}

/**
 * The card of a call the platform presented. `fallbackLabel` is the tool's own name
 * (translated), used for a tool the platform gives no richer label.
 */
export function presentCall(
  p: ToolPresentation,
  t: ChatTranslate,
  fallbackLabel: string,
): PresentedCall {
  const subject = p.subject;
  const idText = subject ? { idText: subjectName(subject) } : {};
  // An operation or a proxied request: « Lecture · Agents », « Écriture ».
  const op = operationLabel(p, t);
  if (op) return { label: op, subject, Icon: methodIcon(p.method) ?? ZapIcon, ...idText };
  // A remote integration tool: « GitHub · Search issues ».
  if (subject?.kind === "integration") {
    return { label: `${subjectName(subject)} · ${p.title}`, subject };
  }
  return { label: fallbackLabel, subject, ...idText };
}
