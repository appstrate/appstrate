// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/openapi-cache.ts` — covers the ETag dance, cache
 * corruption recovery, `--no-cache` / `--refresh` flag semantics, and
 * the auth-error propagation path.
 *
 * Strategy: inject a stub fetcher so we never touch the network, then
 * point `XDG_CACHE_HOME` at a per-test tmpdir so read/write go to disk
 * without polluting the user's home. The real `apiFetchRaw` is NOT
 * exercised here — that path is covered by the command integration
 * test.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchOpenApi, getCacheDir, type OpenApiDocument } from "../src/lib/openapi-cache.ts";
import { AuthError } from "../src/lib/api.ts";

type StubCall = { headers: Record<string, string>; path: string };

const SAMPLE_DOC: OpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "Fixture", version: "1.0.0" },
  paths: {},
};

let tmp: string;
let originalXdg: string | undefined;

function stubFetcher(responder: (call: StubCall) => Response | Promise<Response>): {
  fetcher: Parameters<typeof fetchOpenApi>[2];
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetcher = async (
    _profileName: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ path, headers });
    return responder({ path, headers });
  };
  return { fetcher, calls };
}

beforeAll(() => {
  originalXdg = process.env.XDG_CACHE_HOME;
});

afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdg;
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "appstrate-cli-openapi-cache-"));
  process.env.XDG_CACHE_HOME = tmp;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("getCacheDir", () => {
  it("honors XDG_CACHE_HOME", () => {
    expect(getCacheDir()).toBe(join(tmp, "appstrate"));
  });

  it("falls back to ~/.cache/appstrate when XDG_CACHE_HOME is unset", () => {
    delete process.env.XDG_CACHE_HOME;
    const dir = getCacheDir();
    expect(dir).toMatch(/\.cache\/appstrate$/);
    // Restore so afterEach cleanup works
    process.env.XDG_CACHE_HOME = tmp;
  });
});

describe("fetchOpenApi — fresh fetch (cache miss)", () => {
  it("GETs /api/openapi.json with no If-None-Match when cache is empty", async () => {
    const { fetcher, calls } = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"v1"' },
        }),
    );
    const doc = await fetchOpenApi("default", {}, fetcher);
    expect(doc.openapi).toBe("3.1.0");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/openapi.json");
    expect(calls[0]!.headers["If-None-Match"]).toBeUndefined();
    // Cache was written
    const cached = await readFile(join(getCacheDir(), "openapi-default.json"), "utf-8");
    expect(JSON.parse(cached)).toEqual(SAMPLE_DOC);
    const etag = await readFile(join(getCacheDir(), "openapi-default.etag"), "utf-8");
    expect(etag).toBe('"v1"');
  });

  it("writes cache without ETag when server doesn't send one", async () => {
    const { fetcher } = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await fetchOpenApi("default", {}, fetcher);
    const etagPath = join(getCacheDir(), "openapi-default.etag");
    // ETag file should not exist
    const exists = await stat(etagPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("surfaces AuthError on 401", async () => {
    const { fetcher } = stubFetcher(
      () =>
        new Response(JSON.stringify({ error: "unauth" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(fetchOpenApi("default", {}, fetcher)).rejects.toBeInstanceOf(AuthError);
  });

  it("throws on non-2xx (other than 304)", async () => {
    const { fetcher } = stubFetcher(
      () =>
        new Response("boom", {
          status: 502,
          statusText: "Bad Gateway",
        }),
    );
    await expect(fetchOpenApi("default", {}, fetcher)).rejects.toThrow(/HTTP 502/);
  });

  it("throws when the body is not valid JSON", async () => {
    const { fetcher } = stubFetcher(
      () =>
        new Response("not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(fetchOpenApi("default", {}, fetcher)).rejects.toThrow(/not valid JSON/);
  });
});

describe("fetchOpenApi — cache hit with ETag revalidation", () => {
  it("sends If-None-Match from cached ETag and returns cache on 304", async () => {
    // Seed cache
    let { fetcher, calls } = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
          headers: { ETag: '"v1"' },
        }),
    );
    await fetchOpenApi("default", {}, fetcher);
    expect(calls).toHaveLength(1);

    // Second call should send If-None-Match and receive 304
    ({ fetcher, calls } = stubFetcher(({ headers }) => {
      expect(headers["If-None-Match"]).toBe('"v1"');
      return new Response(null, { status: 304 });
    }));
    const doc = await fetchOpenApi("default", {}, fetcher);
    expect(doc.openapi).toBe("3.1.0");
    expect(calls).toHaveLength(1);
  });

  it("overwrites cache when server returns 200 with a new ETag", async () => {
    // Seed
    let { fetcher } = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
          headers: { ETag: '"v1"' },
        }),
    );
    await fetchOpenApi("default", {}, fetcher);

    // Server responds with new doc + new ETag
    const newDoc: OpenApiDocument = { ...SAMPLE_DOC, info: { title: "Changed", version: "2.0.0" } };
    ({ fetcher } = stubFetcher(
      () =>
        new Response(JSON.stringify(newDoc), {
          status: 200,
          headers: { ETag: '"v2"' },
        }),
    ));
    const doc = await fetchOpenApi("default", {}, fetcher);
    expect(doc.info?.title).toBe("Changed");
    const cached = JSON.parse(await readFile(join(getCacheDir(), "openapi-default.json"), "utf-8"));
    expect(cached.info.title).toBe("Changed");
    const etag = await readFile(join(getCacheDir(), "openapi-default.etag"), "utf-8");
    expect(etag).toBe('"v2"');
  });

  it("throws a clear error when the server sends 304 with no cache present", async () => {
    const { fetcher } = stubFetcher(() => new Response(null, { status: 304 }));
    await expect(fetchOpenApi("default", {}, fetcher)).rejects.toThrow(
      /304 Not Modified but no cached/,
    );
  });
});

describe("fetchOpenApi — corruption tolerance", () => {
  it("treats unparseable cache JSON as a miss (refetches)", async () => {
    const dir = getCacheDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "openapi-default.json"), "{not valid");
    await writeFile(join(dir, "openapi-default.etag"), '"v1"');

    const { fetcher, calls } = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
          headers: { ETag: '"v2"' },
        }),
    );
    const doc = await fetchOpenApi("default", {}, fetcher);
    expect(doc.openapi).toBe("3.1.0");
    // No If-None-Match sent because read failed entirely
    expect(calls[0]!.headers["If-None-Match"]).toBeUndefined();
  });

  it("reads cache even when ETag file is missing (no revalidation, downloads fresh)", async () => {
    const dir = getCacheDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "openapi-default.json"), JSON.stringify(SAMPLE_DOC));
    // No etag file

    const { fetcher, calls } = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
        }),
    );
    await fetchOpenApi("default", {}, fetcher);
    // No If-None-Match since we have no ETag
    expect(calls[0]!.headers["If-None-Match"]).toBeUndefined();
  });

  it("wipes stale ETag when re-fetch returns no ETag header", async () => {
    // Seed with ETag
    let { fetcher } = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
          headers: { ETag: '"v1"' },
        }),
    );
    await fetchOpenApi("default", {}, fetcher);
    expect(
      await stat(join(getCacheDir(), "openapi-default.etag"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    // Refresh: server no longer sends ETag
    ({ fetcher } = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
        }),
    ));
    await fetchOpenApi("default", { refresh: true }, fetcher);
    const exists = await stat(join(getCacheDir(), "openapi-default.etag"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});

describe("fetchOpenApi — flags (noCache, refresh)", () => {
  it("--no-cache skips both read and write", async () => {
    // Seed cache so a read would hit
    const seed = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
          headers: { ETag: '"v1"' },
        }),
    );
    await fetchOpenApi("default", {}, seed.fetcher);
    const etagPath = join(getCacheDir(), "openapi-default.etag");
    const cachePath = join(getCacheDir(), "openapi-default.json");
    const beforeEtag = await readFile(etagPath, "utf-8");

    // Second call with --no-cache and a different server response —
    // MUST NOT send If-None-Match, MUST NOT update cache
    const second = stubFetcher(
      () =>
        new Response(JSON.stringify({ ...SAMPLE_DOC, info: { title: "New", version: "2.0.0" } }), {
          status: 200,
          headers: { ETag: '"v99"' },
        }),
    );
    const doc = await fetchOpenApi("default", { noCache: true }, second.fetcher);
    expect(doc.info?.title).toBe("New");
    expect(second.calls[0]!.headers["If-None-Match"]).toBeUndefined();
    // Cache unchanged
    const afterEtag = await readFile(etagPath, "utf-8");
    expect(afterEtag).toBe(beforeEtag);
    const cached = JSON.parse(await readFile(cachePath, "utf-8"));
    expect(cached.info.title).toBe("Fixture");
  });

  it("--refresh skips read but writes new cache", async () => {
    // Seed
    const seed = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
          headers: { ETag: '"v1"' },
        }),
    );
    await fetchOpenApi("default", {}, seed.fetcher);

    // Refresh should skip If-None-Match AND overwrite cache
    const refresh = stubFetcher(
      () =>
        new Response(
          JSON.stringify({ ...SAMPLE_DOC, info: { title: "Refreshed", version: "3.0.0" } }),
          {
            status: 200,
            headers: { ETag: '"v2"' },
          },
        ),
    );
    const doc = await fetchOpenApi("default", { refresh: true }, refresh.fetcher);
    expect(doc.info?.title).toBe("Refreshed");
    expect(refresh.calls[0]!.headers["If-None-Match"]).toBeUndefined();
    const etag = await readFile(join(getCacheDir(), "openapi-default.etag"), "utf-8");
    expect(etag).toBe('"v2"');
  });
});

describe("fetchOpenApi — profile isolation", () => {
  it("stores caches under per-profile filenames", async () => {
    const { fetcher } = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
          headers: { ETag: '"v1"' },
        }),
    );
    await fetchOpenApi("alice", {}, fetcher);
    await fetchOpenApi("bob", {}, fetcher);
    const aliceCache = await stat(join(getCacheDir(), "openapi-alice.json"));
    const bobCache = await stat(join(getCacheDir(), "openapi-bob.json"));
    expect(aliceCache.size).toBeGreaterThan(0);
    expect(bobCache.size).toBeGreaterThan(0);
  });

  it("URL-encodes profile names with path separators", async () => {
    const { fetcher } = stubFetcher(
      () =>
        new Response(JSON.stringify(SAMPLE_DOC), {
          status: 200,
        }),
    );
    await fetchOpenApi("weird/name", {}, fetcher);
    const cache = await stat(join(getCacheDir(), "openapi-weird%2Fname.json"));
    expect(cache.size).toBeGreaterThan(0);
  });
});
