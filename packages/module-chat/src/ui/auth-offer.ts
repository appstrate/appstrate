// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helper (no React) that pulls an OAuth `{ auth_url, state }` offer out of
 * an `invoke_operation` tool result, tolerating every envelope the result can
 * arrive in. Kept React-free so it can be unit-tested without a DOM.
 *
 * Envelopes seen in the wild:
 *  - direct REST body: `{ auth_url, state }` (snake) or `{ authUrl, state }`.
 *  - raw MCP CallToolResult: `{ content: [{ type:"text", text:"<JSON>" }] }`.
 *  - AI SDK MCP bridge output: `{ type:"content", value:[{ type:"text", text }] }`
 *    or `{ type:"json", value:{...} }` (the `value` key, NOT `content`).
 *  - a flattened JSON string.
 */

export interface AuthOffer {
  authUrl: string;
  state?: string;
}

export function extractAuthOffer(result: unknown): AuthOffer | null {
  if (typeof result === "string") {
    try {
      return extractAuthOffer(JSON.parse(result));
    } catch {
      return null;
    }
  }
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  // Direct hit (the REST body, snake or camel).
  const url = r.auth_url ?? r.authUrl;
  if (typeof url === "string") {
    return { authUrl: url, state: typeof r.state === "string" ? r.state : undefined };
  }

  // Array envelopes (`content` for raw MCP, `value` for the AI SDK bridge): each
  // text part may itself be the JSON body.
  for (const key of ["content", "value"]) {
    const arr = r[key];
    if (Array.isArray(arr)) {
      for (const part of arr) {
        const text = (part as { text?: unknown })?.text;
        if (typeof text === "string") {
          try {
            const nested = extractAuthOffer(JSON.parse(text));
            if (nested) return nested;
          } catch {
            // part wasn't JSON — ignore
          }
        } else if (part && typeof part === "object") {
          const nested = extractAuthOffer(part);
          if (nested) return nested;
        }
      }
    }
  }

  // Object envelopes: `{ type:"json", value:{...} }`, structured content, etc.
  for (const key of ["value", "structuredContent", "data", "result", "output"]) {
    const child = r[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const nested = extractAuthOffer(child);
      if (nested) return nested;
    }
  }
  return null;
}
