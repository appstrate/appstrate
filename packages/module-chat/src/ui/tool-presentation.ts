// SPDX-License-Identifier: Apache-2.0

/**
 * How a tool call is named, wherever it is shown: its card in the thread and its row in the
 * conversation's context panel read the same icon, label and target from here.
 */

import {
  BookOpenIcon,
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

export interface ToolPresentation {
  Icon: LucideIcon;
  /** Translated with the chat's `t`; absent, `label` is shown verbatim (a tool's own name). */
  labelKey?: string;
  label?: string;
  /** What the call acted on: an operation, an integration tool, a query, a file. */
  target?: string;
}

// Readable label + icon for an Appstrate API operation, by verb prefix — a
// heuristic, not an exhaustive operationId map (which would rot). The first
// match wins; unmatched ops fall back to the neutral `tool.op.other`.
const OP_RULES: { re: RegExp; labelKey: string; Icon: LucideIcon; lookup?: true }[] = [
  { re: /^(run|trigger|execute|start)/i, labelKey: "tool.op.launch", Icon: PlayIcon },
  { re: /^(create|post|add|import|upload)/i, labelKey: "tool.op.create", Icon: PlusIcon },
  { re: /^(update|patch|put|set|rename|configure)/i, labelKey: "tool.op.update", Icon: PencilIcon },
  { re: /^(delete|remove|cancel|archive)/i, labelKey: "tool.op.delete", Icon: Trash2Icon },
  { re: /^(list|get|search|find|read)/i, labelKey: "tool.op.read", Icon: SearchIcon, lookup: true },
];

const OTHER_OP = { Icon: ZapIcon, labelKey: "tool.op.other" };

/** The presentation of an `invoke_operation` call, by its operation id. */
export function operationPresentation(operationId: string): { Icon: LucideIcon; labelKey: string } {
  return OP_RULES.find((rule) => rule.re.test(operationId)) ?? OTHER_OP;
}

/**
 * The platform tools that only read: the ones the MCP server declares `readOnlyHint` (`search` and
 * `describe` included, whose live catalog reads leave the platform unchanged), and the chat's own
 * resource read.
 */
const LOOKUP_TOOLS: ReadonlySet<string> = new Set([
  "search",
  "describe",
  "get_me",
  "read",
  "list_files",
  "validate_package_file",
  "get_runtime_capabilities",
  "read_resource",
]);

/** A call that only reads: counted, but kept apart from the actions the assistant took. */
export function isLookupCall(toolName: string, input: unknown): boolean {
  if (LOOKUP_TOOLS.has(toolName)) return true;
  if (toolName !== "invoke_operation") return false;
  const operationId = stringField(input, "operation_id") ?? "";
  return OP_RULES.find((rule) => rule.re.test(operationId))?.lookup === true;
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

/** The icon, label and target of a call, from its tool name and input alone. */
export function toolPresentation(toolName: string, input: unknown): ToolPresentation {
  switch (toolName) {
    case "invoke_operation": {
      const operationId = stringField(input, "operation_id");
      return { ...operationPresentation(operationId ?? ""), target: operationId };
    }
    case "run_and_wait": {
      const scope = stringField(input, "scope");
      const name = stringField(input, "name");
      return {
        Icon: PlayIcon,
        labelKey: "tool.op.launch",
        target: scope && name ? `${scope}/${name}` : undefined,
      };
    }
    case "call_integration_tool": {
      // `{namespace}__{tool}`: no namespace holds `__`, and it is a lossy cut of the package id,
      // so only the tool's own name is worth reading.
      const id = stringField(input, "tool");
      const cut = id?.indexOf("__") ?? -1;
      return {
        Icon: PlugIcon,
        labelKey: "tool.integrationTool",
        target: id && cut > 0 ? id.slice(cut + 2) : id,
      };
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
      return { Icon: FileTextIcon, labelKey: "tool.read", target: stringField(input, "uri") };
    default:
      return { Icon: WrenchIcon, label: toolName };
  }
}

/** A card's icon, label and target (`idText`), as the context panel names the same call. */
export function presented(call: { toolName: string; args: unknown }) {
  const { Icon, labelKey, label, target } = toolPresentation(call.toolName, call.args);
  return { Icon, labelKey, label, idText: target };
}
