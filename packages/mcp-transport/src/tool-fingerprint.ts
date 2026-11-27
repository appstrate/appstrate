// SPDX-License-Identifier: Apache-2.0

/**
 * Identity of a listed tool definition: what an approval is bound to, so a server that changes
 * what the model reads or a caller acts on no longer matches the definition someone approved.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isToolMarkerMetaKey } from "./sanitize.ts";

/**
 * SHA-256 hex over the parts of a tool definition the model or a caller acts on, `execution` and
 * `_meta` included (minus the first-party markers sanitising strips). Computed
 * on the RAW listed tool, before sanitising: sanitising rules may change between releases, the
 * fingerprint must not.
 */
export function toolDefinitionFingerprint(tool: Tool): string {
  const { name, title, description, inputSchema, outputSchema, annotations, execution } = tool;
  const kept = Object.entries(tool._meta ?? {}).filter(([key]) => !isToolMarkerMetaKey(key));
  const _meta = kept.length > 0 ? Object.fromEntries(kept) : undefined;
  // The round-trip drops `undefined` members and turns NaN / array holes into null, leaving
  // plain JSON for the key-sorted stringify below.
  const payload = JSON.parse(
    JSON.stringify({
      name,
      title,
      description,
      inputSchema,
      outputSchema,
      annotations,
      execution,
      _meta,
    }),
  );
  return new Bun.CryptoHasher("sha256").update(sortedJson(payload)).digest("hex");
}

/** Key order must not move the digest: a server may reorder its schema between listings. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(obj[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}
