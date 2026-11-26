// SPDX-License-Identifier: Apache-2.0

/**
 * How a tool call is shown, wherever it is shown: its card in the thread and its row in the
 * conversation's context panel both read {@link showCall}, with the presentation
 * {@link callPresentation} reads off the call's stored part.
 *
 * Once the result lands, the call is drawn from the presentation the platform stamps on it
 * (`@appstrate/core/mcp-presentation`), which the engine relays as the result's provider metadata
 * (`pi-chat/ui-stream-mapper.ts`), on a success and on a failure alike: the integration, agent or
 * user it acted on, and for an operation or a proxied request its HTTP method. Nothing is guessed
 * from an operation id, and no English text of the server is shown for a proxied request. Until a
 * result carries a presentation, the call keeps its own name and what its arguments name.
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

/** One call as its card and its panel row show it. */
export interface ShownCall {
  /** Drawn unless `subject` is: its glyph wins. */
  Icon: LucideIcon;
  /** Already translated. */
  label: string;
  idText?: string;
  subject?: PresentationSubject;
}

function stringField(input: unknown, key: string): string | undefined {
  const value = asRecordOrNull(input)?.[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * The name `call_integration_tool` calls a tool by, within its integration: `{namespace}__{tool}`,
 * where no namespace holds `__` and the namespace is a lossy cut of the package id.
 */
function integrationToolName(input: unknown): string | undefined {
  const id = stringField(input, "tool");
  const cut = id?.indexOf("__") ?? -1;
  return id && cut > 0 ? id.slice(cut + 2) : id;
}

/** A call's icon and what its arguments name (an operation, a tool, a query, a file). */
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

/**
 * What the engine stamped on a call's outcome (`pi-chat/ui-stream-mapper.ts`):
 * `resultProviderMetadata.appstrate` of its stored tool part, present on a success and on a
 * failure alike; `null` while the call runs.
 */
export function callOutcome(part: object | undefined): Record<string, unknown> | null {
  const metadata =
    part && "resultProviderMetadata" in part ? part.resultProviderMetadata : undefined;
  return asRecordOrNull(asRecordOrNull(metadata)?.appstrate);
}

/**
 * The presentation stamped on a call's result ({@link callOutcome}). `undefined` while the call
 * runs, or for a malformed stamp.
 */
export function callPresentation(part: object | undefined): ToolPresentation | undefined {
  const raw = callOutcome(part)?.presentation;
  if (raw === undefined) return undefined;
  const parsed = toolPresentationSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The verb icon of an HTTP method; `undefined` for a method that names none. POST is neutral: it
 * does not say what the request does (RFC 9110 §9.3.3), so it draws an action, not a creation.
 */
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

/** « Lecture », « Action », « Mise à jour »: the method's verb, translated. */
function verbOf(method: string, t: ChatTranslate): string {
  return t(`tool.verb.${method}`, { defaultValue: method });
}

/** The name a subject is shown under. */
export function subjectName(subject: PresentationSubject): string {
  return subject.display_name ?? subject.id;
}

/** An integration's `api_*` tool (`{ns}__api_call`, its upload twin): a proxied request. */
function isProxiedRequest(input: unknown): boolean {
  return integrationToolName(input)?.startsWith("api_") === true;
}

/** The requests a proxied call sends (`arguments.requests`); `undefined` for any other call. */
function proxiedRequests(input: unknown): unknown[] | undefined {
  if (!isProxiedRequest(input)) return undefined;
  const requests = asRecordOrNull(asRecordOrNull(input)?.arguments)?.requests;
  return Array.isArray(requests) ? requests : undefined;
}

/**
 * The path a proxied request targets (`requests[0].target`), without its origin, query string or
 * fragment: what the request reads or writes, short enough for a row.
 */
function targetPath(request: unknown): string | undefined {
  const target = stringField(request, "target");
  if (!target) return undefined;
  try {
    return new URL(target).pathname;
  } catch {
    // A relative target: the path is what precedes its query or fragment.
    return target.split(/[?#]/, 1)[0] || undefined;
  }
}

/**
 * How a call is shown: from the platform's presentation once it landed, else its own name. A
 * label reads « domain · what », wherever the call is drawn.
 *
 * - An operation (an OpenAPI tag and method): « Agents · Lecture », identified by its subject,
 *   else its operation id.
 * - A call that reached an integration, drawn with its logo: « Gmail · Lecture » for a proxied
 *   request, identified by the path it targets, « Gmail · 3 requêtes » for a batch,
 *   « GitHub · Search issues » for a remote tool (the title its server gives it). A proxied call
 *   whose request cannot be read, or a call whose tool cannot, says « Gmail · Outil
 *   d'intégration »: the server's own label for a proxied request is English, never shown.
 * - Any other tool: its own name (`tool.name.<tool>`), identified by its subject or its arguments.
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
      label: `${t(`tool.tag.${p.tag}`, { defaultValue: p.tag })} · ${verbOf(method, t)}`,
      ...(idText ? { idText } : {}),
      ...(subject ? { subject } : {}),
    };
  }
  if (subject?.kind === "integration") {
    const requests = proxiedRequests(call.args);
    const path = method && requests?.length === 1 ? targetPath(requests[0]) : undefined;
    // A proxied request names its method, a batch its requests; a remote tool keeps its title.
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
