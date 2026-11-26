// SPDX-License-Identifier: Apache-2.0

/**
 * How a tool call is shown, wherever it is shown: its card in the thread and its row in the
 * conversation's context panel both read {@link showCall}.
 *
 * Once the result lands, the call is drawn from the presentation the platform stamps on it
 * (`@appstrate/core/mcp-presentation`, relayed by the engine as `result.presentation`): the
 * integration, agent or user it acted on, and for an operation its HTTP method and OpenAPI tag.
 * Nothing is guessed from an operation id. Before the result lands, and for a reply persisted
 * before the stamp existed, the call keeps its own name and what its arguments name.
 */

import {
  BookOpenIcon,
  EyeIcon,
  FileTextIcon,
  PencilIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import {
  toolPresentationSchema,
  type PresentationSubject,
  type ToolPresentation,
} from "@appstrate/core/mcp-presentation";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import type { ChatTranslate } from "./runtime-context.ts";

/** A call's own name, from its tool and arguments alone. */
interface OwnName {
  Icon: LucideIcon;
  /** Translated; absent, the tool's `tool.name.<tool>`, else its presented title or name. */
  labelKey?: string;
  /** What the arguments name: an operation, an integration tool, a query, a file. */
  target?: string;
}

function stringField(input: unknown, key: string): string | undefined {
  const value = asRecordOrNull(input)?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function ownName(toolName: string, input: unknown): OwnName {
  switch (toolName) {
    case "invoke_operation":
      return {
        Icon: ZapIcon,
        labelKey: "tool.op.other",
        target: stringField(input, "operation_id"),
      };
    case "run_and_wait": {
      const scope = stringField(input, "scope");
      const name = stringField(input, "name");
      return { Icon: PlayIcon, target: scope && name ? `${scope}/${name}` : undefined };
    }
    case "call_integration_tool": {
      // `{namespace}__{tool}`: no namespace holds `__`, and it is a lossy cut of the package id,
      // so only the tool's own name is worth reading.
      const id = stringField(input, "tool");
      const cut = id?.indexOf("__") ?? -1;
      return { Icon: PlugIcon, target: id && cut > 0 ? id.slice(cut + 2) : id };
    }
    case "import_package_file":
      return {
        Icon: UploadIcon,
        labelKey: "tool.importPackageFile",
        target: stringField(input, "file_uri"),
      };
    case "search":
      return { Icon: SearchIcon, labelKey: "tool.search", target: stringField(input, "query") };
    case "describe":
      return { Icon: BookOpenIcon, labelKey: "tool.describe", target: stringField(input, "id") };
    case "read":
      return { Icon: FileTextIcon, target: stringField(input, "uri") };
    default:
      return { Icon: WrenchIcon };
  }
}

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
  // `call_integration_tool`: « GitHub · Search issues ».
  if (p.subject?.kind === "integration") {
    return { label: `${subjectName(p.subject)} · ${p.title}`, subject };
  }
  const op = operationLabel(p, t);
  if (op) {
    return {
      label: op,
      subject,
      Icon: methodIcon(p.method) ?? ZapIcon,
      idText: p.subject ? subjectName(p.subject) : p.title,
    };
  }
  return {
    label: fallbackLabel,
    subject,
    ...(p.subject ? { idText: subjectName(p.subject) } : {}),
  };
}

/** One call as its card and its panel row show it. */
export interface ShownCall {
  /** Drawn unless `subject` is: its glyph wins. */
  Icon: LucideIcon;
  /** Already translated. */
  label: string;
  idText?: string;
  subject?: PresentationSubject;
}

/** How a call is shown: from the platform's presentation once it landed, else its own name. */
export function showCall(
  call: { toolName: string; args: unknown; result?: unknown },
  t: ChatTranslate,
): ShownCall {
  const own = ownName(call.toolName, call.args);
  const presentation = presentationOf(call.result);
  const ownLabel = own.labelKey
    ? t(own.labelKey)
    : t(`tool.name.${call.toolName}`, { defaultValue: presentation?.title ?? call.toolName });
  if (!presentation) return { Icon: own.Icon, label: ownLabel, idText: own.target };
  const presented = presentCall(presentation, t, ownLabel);
  return {
    Icon: presented.Icon ?? own.Icon,
    label: presented.label,
    // An integration call's label already names its tool.
    idText:
      presented.idText ?? (presented.subject?.kind === "integration" ? undefined : own.target),
    ...(presented.subject ? { subject: presented.subject } : {}),
  };
}
