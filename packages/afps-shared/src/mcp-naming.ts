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
  const out = trimUnderscores(
    raw
      .replace(/^@/, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .toLowerCase(),
  );
  return out.slice(0, MCP_TOOL_NAMESPACE_BASE_MAX_LENGTH);
}

/**
 * Exposed tool-name grammar: `{snake_namespace}__{body}`, the body in the LLM
 * providers' `^[a-zA-Z0-9_-]{1,64}$` alphabet (56-char ceiling: re-prefix headroom).
 */
const MCP_TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_]*__[A-Za-z0-9_-]+$/;

export function isValidMcpToolName(name: string): boolean {
  return name.length <= MCP_TOOL_NAME_MAX_LENGTH && MCP_TOOL_NAME_PATTERN.test(name);
}

/**
 * Map an untrusted upstream tool name onto the body alphabet: each rejected
 * code point becomes `_`; nothing else changes.
 */
export function normaliseMcpToolBody(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/gu, "_");
}

const MCP_TOOL_HASH_LENGTH = 8;

/**
 * Exposed name for an untrusted upstream tool: `{namespace}__{body}` when it
 * fits and is free, else the body cut to fit plus a hash of the ORIGINAL
 * upstream name (stable regardless of registration order). One salted re-hash
 * on collision, then it throws.
 */
export function allocateMcpToolName(
  namespace: string,
  upstreamName: string,
  taken: (name: string) => boolean,
): string {
  const body = normaliseMcpToolBody(upstreamName);
  const plain = `${namespace}__${body}`;
  if (isValidMcpToolName(plain) && !taken(plain)) return plain;
  const budget = MCP_TOOL_NAME_MAX_LENGTH - namespace.length - 2 - MCP_TOOL_HASH_LENGTH - 1;
  const head = body.slice(0, Math.max(0, budget));
  for (const seed of [upstreamName, `${upstreamName}\0`]) {
    const hash = fnv1a64Hex(seed).slice(0, MCP_TOOL_HASH_LENGTH);
    const candidate = head ? `${namespace}__${head}_${hash}` : `${namespace}__${hash}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`MCP tool name ${JSON.stringify(upstreamName)} collides after re-hashing`);
}

/** 64-bit FNV-1a over the UTF-8 bytes, as 16 lowercase hex digits. */
export function fnv1a64Hex(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
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
