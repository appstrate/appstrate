// SPDX-License-Identifier: Apache-2.0

/**
 * Pure application of a provider's declarative {@link OAuthWireFormat}.
 *
 * The same contract drives two consumers, which MUST stay byte-identical
 * (these fingerprints gate whether a subscription backend accepts a call):
 *   - the in-container sidecar (`runtime-pi/sidecar/oauth-identity.ts`),
 *     for agent runs;
 *   - the first-party LLM proxy (`apps/api/src/services/llm-proxy/*`),
 *     for the chat / dashboard.
 *
 * Keeping the logic here, in `@appstrate/core`, makes the module's
 * `ModelProviderDefinition.oauthWireFormat` the single source of truth for
 * both paths — a new OAuth provider is a declarative change, and the two
 * call sites can never drift.
 */

import type { OAuthWireFormat } from "./sidecar-types.ts";

/**
 * Static fingerprint headers + optional `accountId` routing echo. Returns
 * lower-cased keys; the caller must ensure these survive any header
 * filtering. Empty object when `wireFormat` carries no identity fields.
 */
export function buildIdentityHeaders(
  wireFormat: OAuthWireFormat | undefined,
  accountId: string | undefined,
): Record<string, string> {
  if (!wireFormat) return {};
  const headers: Record<string, string> = { ...(wireFormat.identityHeaders ?? {}) };
  if (wireFormat.accountIdHeader && accountId) {
    headers[wireFormat.accountIdHeader] = accountId;
  }
  return headers;
}

interface SystemTextBlock {
  type: "text";
  text: string;
}

function applySystemPrepend(
  json: Record<string, unknown>,
  prepend: { type: "text"; text: string },
): void {
  const identityBlock: SystemTextBlock = { type: "text", text: prepend.text };
  const system = json.system;
  if (Array.isArray(system)) {
    const first = system[0] as SystemTextBlock | undefined;
    const alreadyPrepended = first?.type === "text" && first.text === prepend.text;
    json.system = alreadyPrepended ? system : [identityBlock, ...system];
  } else if (typeof system === "string") {
    json.system =
      system === prepend.text ? [identityBlock] : [identityBlock, { type: "text", text: system }];
  } else {
    json.system = [identityBlock];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply per-provider request-body transforms (system prelude + stream/store
 * coercion). Pure over JSON text. Returns the input unchanged when the
 * wire format carries no body-level transform or the body isn't JSON.
 */
export function applyOAuthBodyTransform(
  wireFormat: OAuthWireFormat | undefined,
  bodyText: string,
): string {
  const wantsTransform =
    !!wireFormat?.systemPrepend ||
    wireFormat?.forceStream !== undefined ||
    wireFormat?.forceStore !== undefined;
  if (!wantsTransform || !bodyText) return bodyText;

  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!isPlainObject(json)) return bodyText;

  if (wireFormat?.systemPrepend) applySystemPrepend(json, wireFormat.systemPrepend);
  if (wireFormat?.forceStream !== undefined) json.stream = wireFormat.forceStream;
  if (wireFormat?.forceStore !== undefined) json.store = wireFormat.forceStore;
  return JSON.stringify(json);
}
