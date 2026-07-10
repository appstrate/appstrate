// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/** Appstrate's MCP tool-name ceiling, including the namespace. */
export const MCP_TOOL_NAME_MAX_LENGTH = 56;

/** Maximum namespace length before McpHost adds an optional `_2`…`_999`. */
export const MCP_TOOL_NAMESPACE_BASE_MAX_LENGTH = 20;

/**
 * Canonical namespace normalisation shared by McpHost and the portable AFPS
 * runtime. Package ids such as `@appstrate/google-drive` become a lowercase
 * snake-case namespace capped before collision suffixing.
 */
export function normaliseMcpToolNamespace(raw: string): string {
  if (typeof raw !== "string") return "";
  const out = trimUnderscores(
    raw
      .replace(/^@/, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .toLowerCase(),
  );
  return out.slice(0, MCP_TOOL_NAMESPACE_BASE_MAX_LENGTH);
}

/**
 * Canonicalise an untrusted upstream tool body before adding our namespace.
 * An upstream namespace is stripped so `drive__api-call` becomes `api_call`,
 * matching McpHost's outward naming contract.
 */
export function normaliseMcpToolBody(raw: string): string {
  if (typeof raw !== "string") return "";
  let out = trimUnderscores(raw.replace(/[^a-zA-Z0-9_]+/g, "_").toLowerCase());
  const separator = out.indexOf("__");
  if (separator >= 0 && separator < out.length - 2) {
    out = out.slice(separator + 2);
  }
  return out;
}

/** Trim underscore runs in linear time without a backtracking expression. */
function trimUnderscores(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 95) start += 1;
  let end = value.length;
  while (end > start && value.charCodeAt(end - 1) === 95) end -= 1;
  return value.slice(start, end);
}

/** Allocate the same `_2`…`_999` namespace suffix used by McpHost. */
export function allocateMcpToolNamespace(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`exhausted MCP namespace suffixes for ${JSON.stringify(base)}`);
}
