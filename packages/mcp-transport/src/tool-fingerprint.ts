// SPDX-License-Identifier: Apache-2.0

/**
 * Identity of a listed tool definition: what an approval is bound to, so a server that changes
 * what the model reads or a caller acts on no longer matches the definition someone approved.
 */

import { canonicalJsonStringify } from "@appstrate/afps-runtime/bundle";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * SHA-256 hex over the parts of a tool definition the model or a caller acts on. Computed on the
 * RAW listed tool, before sanitising: sanitising rules may change between releases, the
 * fingerprint must not.
 */
export function toolDefinitionFingerprint(tool: Tool): string {
  const { name, title, description, inputSchema, outputSchema, annotations } = tool;
  // The JSON round-trip drops `undefined` members and turns the odd value a server can send
  // (undefined array slot, NaN) into null, where canonicalJsonStringify would throw.
  const payload = JSON.parse(
    JSON.stringify({ name, title, description, inputSchema, outputSchema, annotations }),
  );
  return new Bun.CryptoHasher("sha256").update(canonicalJsonStringify(payload)).digest("hex");
}

/** True when the tool needs no approval, or its live fingerprint is among the approved ones. */
export function definitionApproved(
  name: string,
  fingerprint: string,
  approved: Readonly<Record<string, readonly string[]>> | undefined,
): boolean {
  const fingerprints = approved?.[name];
  return fingerprints === undefined || fingerprints.includes(fingerprint);
}
