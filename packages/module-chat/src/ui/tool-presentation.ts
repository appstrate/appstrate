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
  toolPresentationSchema,
  type PresentationSubject,
  type ToolPresentation,
} from "@appstrate/core/mcp-presentation";
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
      return { Icon: BookOpenIcon, target: stringField(input, "id") };
    case "read":
    case "read_resource":
      return { Icon: FileTextIcon, target: stringField(input, "uri") };
    default:
      return { Icon: WrenchIcon };
  }
}

/** The engine's stamp on a call's outcome, failed or not (`ui-stream-mapper.ts`); `null` while it runs. */
export function callOutcome(part: object | undefined): Record<string, unknown> | null {
  const metadata =
    part && "resultProviderMetadata" in part ? part.resultProviderMetadata : undefined;
  return asRecordOrNull(asRecordOrNull(metadata)?.appstrate);
}

/** The presentation stamped on a call's outcome; `undefined` while it runs, or malformed. */
export function callPresentation(part: object | undefined): ToolPresentation | undefined {
  const raw = callOutcome(part)?.presentation;
  if (raw === undefined) return undefined;
  const parsed = toolPresentationSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
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

/** `{ns}__api_call` or its upload twin: a proxied request. */
function isProxiedRequest(input: unknown): boolean {
  return integrationToolName(input)?.startsWith("api_") === true;
}

function proxiedRequests(input: unknown): unknown[] | undefined {
  if (!isProxiedRequest(input)) return undefined;
  const requests = asRecordOrNull(asRecordOrNull(input)?.arguments)?.requests;
  return Array.isArray(requests) ? requests : undefined;
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
  const p = call.presentation;
  const ownLabel = t(`tool.name.${call.toolName}`, { defaultValue: p?.title ?? call.toolName });
  if (!p) return { Icon: own.Icon, label: ownLabel, ...(own.target ? { idText: own.target } : {}) };

  const subject = p.subject;
  const method = p.method?.toUpperCase();
  const Icon = (method ? methodIcon(method) : undefined) ?? own.Icon;
  if (p.tag && method) {
    const idText = subject ? subjectName(subject) : own.target;
    return {
      Icon,
      label: `${t(`tool.tag.${p.tag}`)} · ${verbOf(method, t)}`,
      ...(idText ? { idText } : {}),
      ...(subject ? { subject } : {}),
    };
  }
  if (subject?.kind === "integration") {
    const requests = proxiedRequests(call.args);
    const path = method && requests?.length === 1 ? targetPath(requests[0]) : undefined;
    const what = method
      ? verbOf(method, t)
      : requests !== undefined && requests.length > 1
        ? t("tool.requests", { count: requests.length })
        : integrationToolName(call.args) !== undefined && !isProxiedRequest(call.args)
          ? p.title
          : t("tool.name.call_integration_tool");
    return {
      Icon,
      label: `${subjectName(subject)} · ${what}`,
      ...(path ? { idText: path } : {}),
      subject,
    };
  }
  const idText = subject ? subjectName(subject) : own.target;
  return {
    Icon,
    label: ownLabel,
    ...(idText ? { idText } : {}),
    ...(subject ? { subject } : {}),
  };
}
