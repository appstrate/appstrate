// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for the `/api/models` wire shape the chat reads.
 *
 * The route answers with the Stripe-canonical list envelope
 * `{ object: "list", data, hasMore }` (apps/api `listResponse`; `data` is
 * required by the OpenAPI schema). A second, legacy `{ models: [...] }` branch
 * used to be tolerated here and in the browser picker — accepting a shape the
 * server never sends only hides a real envelope regression, so both readers now
 * read `data` alone.
 */

import { describe, expect, it } from "bun:test";
import { listModels } from "../src/llm.ts";

const ORIGIN = "http://127.0.0.1:3000";

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("listModels", () => {
  it("reads the list envelope's data array", async () => {
    const rows = [{ id: "preset_1", modelId: "gpt-4o", apiShape: "openai-completions" }];
    const models = await listModels(
      ORIGIN,
      {},
      fetchReturning({ object: "list", data: rows, hasMore: false }),
    );
    expect(models).toEqual(rows);
  });

  it("returns empty for a body carrying no data array", async () => {
    // Including the retired `{ models: [...] }` shape: it is no longer a
    // recognised envelope, so it must degrade to empty rather than silently
    // resurrect a wire contract the server dropped.
    expect(await listModels(ORIGIN, {}, fetchReturning({ models: [{ id: "preset_1" }] }))).toEqual(
      [],
    );
    expect(await listModels(ORIGIN, {}, fetchReturning({}))).toEqual([]);
  });

  it("requests the plain catalog URL — no query variant", async () => {
    // The retired `?metadata_only=true` variant used to skip the credential
    // decrypt; the route no longer reads the parameter (a row must be decrypted
    // to know its liveness), and liveness now rides the listed rows as
    // `needs_reconnection`. One URL, one shape.
    let seen = "";
    const spy = (async (url: string | URL | Request) => {
      seen = String(url);
      return new Response(JSON.stringify({ object: "list", data: [], hasMore: false }));
    }) as typeof fetch;

    await listModels(ORIGIN, {}, spy);
    expect(seen).toBe(`${ORIGIN}/api/models`);
  });

  it("throws on a non-ok response rather than reporting an empty catalog", async () => {
    // An empty list and a broken endpoint must not look alike — the caller
    // surfaces a 502, it does not tell the user they have no models.
    // `await` is load-bearing: an un-awaited `.rejects` assertion is never
    // evaluated and the test passes whatever the promise does.
    await expect(listModels(ORIGIN, {}, fetchReturning({}, 500))).rejects.toThrow();
  });
});
