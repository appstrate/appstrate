// SPDX-License-Identifier: Apache-2.0

/**
 * A live-model-catalog channel for tests: a throwaway signing key, files built
 * from bundled Pi records under new ids, and a `fetch` that serves them.
 */

import { getPiModel } from "@appstrate/runner-pi/pi-model";
import { PI_SDK_VERSION } from "@appstrate/runner-pi/provider-map";

export interface CatalogSigner {
  publicKey: string;
  sign(payload: string): Promise<string>;
}

export async function createCatalogSigner(): Promise<CatalogSigner> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString(
    "base64",
  );
  return {
    publicKey,
    async sign(payload) {
      const signature = await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(payload),
      );
      return Buffer.from(signature).toString("base64");
    },
  };
}

/** A catalog record: the bundled record of `bundledId`, as a later registry would list it under `id`. */
export function catalogRecordLike(
  provider: string,
  bundledId: string,
  api: string,
  id: string,
): Record<string, unknown> {
  const bundled = getPiModel(provider, bundledId, api);
  if (!bundled) throw new Error(`${provider} records no ${bundledId} on ${api}`);
  return {
    provider,
    api,
    id,
    name: `${bundled.name} (next)`,
    reasoning: bundled.reasoning,
    input: bundled.input,
    cost: bundled.cost,
    contextWindow: bundled.contextWindow,
    maxTokens: bundled.maxTokens,
    ...(bundled.thinkingLevelMap ? { thinkingLevelMap: bundled.thinkingLevelMap } : {}),
    ...(bundled.compat ? { compat: bundled.compat } : {}),
  };
}

export function catalogFile(records: unknown[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    sdk_version: PI_SDK_VERSION,
    source_version: "99.0.0",
    serial: 100,
    records,
    ...over,
  });
}

/** A channel serving one file (and its signature), recording its requests. */
export function catalogChannel(signer: CatalogSigner) {
  const state = {
    payload: null as string | null,
    requests: [] as Array<{ url: string; redirect: RequestInit["redirect"] }>,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    state.requests.push({ url, redirect: init?.redirect });
    if (state.payload === null) return new Response("not found", { status: 404 });
    if (url.endsWith(".sig")) return new Response(`${await signer.sign(state.payload)}\n`);
    return new Response(state.payload);
  }) as typeof fetch;
  return { state, fetch: fetchImpl };
}
