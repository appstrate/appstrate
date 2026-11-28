// SPDX-License-Identifier: Apache-2.0

/**
 * How a tool call is shown, in the thread and in the context panel alike ({@link showCall}): from
 * the presentation the platform stamps on its result (`@appstrate/core/mcp-presentation`), else
 * its own name and what its arguments name.
 */

import {
  BookOpenIcon,
  EyeIcon,
  FileTextIcon,
  PencilIcon,
  PlayIcon,
  PlugIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import {
  readAppstrateToolPartMetadata,
  type AppstrateToolPartMetadata,
} from "@appstrate/core/chat-turn-metadata";
import { type PresentationSubject, type ToolPresentation } from "@appstrate/core/mcp-presentation";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import type { ChatTranslate } from "./runtime-context.ts";

export interface ShownCall {
  /** Drawn unless `subject` is. */
  Icon: LucideIcon;
  label: string;
  idText?: string;
  subject?: PresentationSubject;
}

function stringField(input: unknown, key: string): string | undefined {
  const value = asRecordOrNull(input)?.[key];
  return typeof value === "string" && value ? value : undefined;
}

/** `call_integration_tool`'s tool, without its `{namespace}__` (no namespace holds `__`). */
function integrationToolName(input: unknown): string | undefined {
  const id = stringField(input, "tool");
  const cut = id?.indexOf("__") ?? -1;
  return id && cut > 0 ? id.slice(cut + 2) : id;
}

/** A `describe` given `ids`: every id it names, in order. */
function describedIds(input: unknown): string | undefined {
  const ids = asRecordOrNull(input)?.ids;
  const named = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id) : [];
  return named.length > 0 ? named.join(", ") : undefined;
}

function ownTarget(toolName: string, input: unknown): { Icon: LucideIcon; target?: string } {
  switch (toolName) {
    case "invoke_operation":
      return { Icon: ZapIcon, target: stringField(input, "operation_id") };
    case "run_and_wait": {
      const scope = stringField(input, "scope");
      const name = stringField(input, "name");
      return { Icon: PlayIcon, target: scope && name ? `${scope}/${name}` : undefined };
    }
    case "call_integration_tool":
      return { Icon: PlugIcon, target: integrationToolName(input) };
    case "import_package_file":
      return { Icon: UploadIcon, target: stringField(input, "file_uri") };
    case "search":
      return { Icon: SearchIcon, target: stringField(input, "query") };
    case "describe":
      return { Icon: BookOpenIcon, target: stringField(input, "id") ?? describedIds(input) };
    case "read":
    case "read_resource":
      return { Icon: FileTextIcon, target: stringField(input, "uri") };
    default:
      return { Icon: WrenchIcon };
  }
}

/** The engine's stamp on a call's outcome, failed or not (`ui-stream-mapper.ts`); `undefined` while it runs. */
export function callOutcome(part: object | undefined): AppstrateToolPartMetadata | undefined {
  const metadata =
    part && "resultProviderMetadata" in part ? part.resultProviderMetadata : undefined;
  return readAppstrateToolPartMetadata(metadata);
}

/** The presentation stamped on a call's outcome; `undefined` while it runs, or malformed. */
export function callPresentation(part: object | undefined): ToolPresentation | undefined {
  return callOutcome(part)?.presentation;
}

/** POST draws an action, not a creation: it does not say what the request does. */
function methodIcon(method: string): LucideIcon | undefined {
  switch (method) {
    case "GET":
    case "HEAD":
      return EyeIcon;
    case "POST":
      return ZapIcon;
    case "PUT":
    case "PATCH":
      return PencilIcon;
    case "DELETE":
      return Trash2Icon;
    default:
      return undefined;
  }
}

function verbOf(method: string, t: ChatTranslate): string {
  return t(`tool.verb.${method}`, { defaultValue: method });
}

export function subjectName(subject: PresentationSubject): string {
  return subject.display_name ?? subject.id;
}

/** What the call acted on, for the variants that name one. */
export function presentationSubject(
  presentation: ToolPresentation | undefined,
): PresentationSubject | undefined {
  return presentation && "subject" in presentation ? presentation.subject : undefined;
}

/** The HTTP method of a call that has one (an operation, a proxied request), upper-cased. */
export function presentationMethod(presentation: ToolPresentation | undefined): string | undefined {
  return presentation?.call === "operation" || presentation?.call === "proxied_request"
    ? presentation.method?.toUpperCase()
    : undefined;
}

/** The image a client draws for a subject: the light one, else the first. */
export function subjectIconSrc(subject: PresentationSubject): string | undefined {
  const icons = subject.icons;
  return (icons?.find((icon) => icon.theme !== "dark") ?? icons?.[0])?.src;
}

/** The path a proxied request targets, without origin, query or fragment. */
function targetPath(request: unknown): string | undefined {
  const target = stringField(request, "target");
  if (!target) return undefined;
  try {
    return new URL(target).pathname;
  } catch {
    return target.split(/[?#]/, 1)[0] || undefined;
  }
}

/**
 * A label reads « domain · what »: « Agents · Lecture » for an operation, « Gmail · Lecture » or
 * « Gmail · 3 requêtes » for a proxied request, « GitHub · Search issues » for a remote tool (a
 * proxied request's own English label is never shown), else the tool's own name.
 */
export function showCall(
  call: { toolName: string; args: unknown; presentation?: ToolPresentation | undefined },
  t: ChatTranslate,
): ShownCall {
  const own = ownTarget(call.toolName, call.args);
  const ownLabel = t(`tool.name.${call.toolName}`, { defaultValue: call.toolName });
  const p = call.presentation;
  const plain = (): ShownCall => ({
    Icon: own.Icon,
    label: ownLabel,
    ...(own.target ? { idText: own.target } : {}),
  });
  if (!p) return plain();
  switch (p.call) {
    case "operation": {
      const method = p.method.toUpperCase();
      const Icon = methodIcon(method) ?? own.Icon;
      const idText = p.subject ? subjectName(p.subject) : own.target;
      return {
        Icon,
        label: p.tag
          ? `${t(`tool.tag.${p.tag}`, { defaultValue: p.tag })} · ${verbOf(method, t)}`
          : ownLabel,
        ...(idText ? { idText } : {}),
        ...(p.subject ? { subject: p.subject } : {}),
      };
    }
    case "proxied_request": {
      const method = p.method?.toUpperCase();
      const requests = asRecordOrNull(asRecordOrNull(call.args)?.arguments)?.requests;
      const path =
        method && p.requests === 1 && Array.isArray(requests) ? targetPath(requests[0]) : undefined;
      const what = method
        ? verbOf(method, t)
        : p.requests !== undefined && p.requests > 1
          ? t("tool.requests", { count: p.requests })
          : t("tool.name.call_integration_tool");
      return {
        Icon: (method ? methodIcon(method) : undefined) ?? own.Icon,
        label: `${subjectName(p.subject)} · ${what}`,
        ...(path ? { idText: path } : {}),
        subject: p.subject,
      };
    }
    case "remote_tool":
      return {
        Icon: own.Icon,
        label: `${subjectName(p.subject)} · ${p.title}`,
        subject: p.subject,
      };
    case "caller":
      return {
        Icon: own.Icon,
        label: ownLabel,
        idText: subjectName(p.subject),
        subject: p.subject,
      };
    case "search":
      return plain();
  }
}
