// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the `openapi` subcommands — exercise the full
 * resolve-profile → fetch (via stubbed global fetch) → format → stdout
 * path. Follows the `whoami.test.ts` harness pattern: fake keyring +
 * `XDG_*` tmpdirs + a per-test injected `CommandIO`.
 *
 * The real `apiFetchRaw` is hit here (no injected fetcher), so this
 * also covers the profile + auth plumbing end-to-end. We deliberately
 * do NOT spin up a Bun.serve — the global `fetch` stub is sufficient
 * for asserting request shape and response behavior without a real
 * socket, and it matches how every other command test in this suite
 * is structured.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _setKeyringFactoryForTesting,
  saveTokens,
  type KeyringHandle,
} from "../src/lib/keyring.ts";
import { setProfile } from "../src/lib/config.ts";
import {
  openapiExportCommand,
  openapiListCommand,
  openapiShowCommand,
} from "../src/commands/openapi.ts";

class FakeKeyring implements KeyringHandle {
  static store = new Map<string, string>();
  constructor(private profile: string) {}
  setPassword(v: string): void {
    FakeKeyring.store.set(this.profile, v);
  }
  getPassword(): string | null {
    return FakeKeyring.store.get(this.profile) ?? null;
  }
  deletePassword(): void {
    FakeKeyring.store.delete(this.profile);
  }
}

/**
 * Every command invocation gets its own `createMemoryIO()` sink rather than
 * a process-wide stream swap. `bun test` runs the whole repo in one process,
 * so a global capture buffer also collected writes from other suites and
 * made assertions like `toBe("")` non-deterministic (issue #1180). A fresh
 * sink per invocation doubles as the segmentation the multi-command tests
 * at the bottom of this file need: "what did the *second* command print?"
 * is answered by that command's own sink, not by clearing a shared array.
 *
 * `io.exit` throws `ExitError`, so exit-code branches unwind without
 * terminating the worker.
 */
import { ExitError } from "./helpers/process-exit.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";

let tmpConfig: string;
let tmpCache: string;
let originalXdgConfig: string | undefined;
let originalXdgCache: string | undefined;
const originalFetch = globalThis.fetch;

let fetchCalls: Array<{ url: string; method: string | undefined; headers: Record<string, string> }>;

function installFetch(responder: (url: string, init?: RequestInit) => Promise<Response>): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({ url, method: init?.method, headers });
    return responder(url, init);
  };
  globalThis.fetch = stub as unknown as typeof fetch;
}

beforeAll(() => {
  originalXdgConfig = process.env.XDG_CONFIG_HOME;
  originalXdgCache = process.env.XDG_CACHE_HOME;
});

afterAll(() => {
  if (originalXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfig;
  if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCache;
});

beforeEach(async () => {
  tmpConfig = await mkdtemp(join(tmpdir(), "appstrate-cli-openapi-cfg-"));
  tmpCache = await mkdtemp(join(tmpdir(), "appstrate-cli-openapi-cache-"));
  process.env.XDG_CONFIG_HOME = tmpConfig;
  process.env.XDG_CACHE_HOME = tmpCache;
  FakeKeyring.store.clear();
  _setKeyringFactoryForTesting((p) => new FakeKeyring(p));
  fetchCalls = [];
});

afterEach(async () => {
  _setKeyringFactoryForTesting(null);
  globalThis.fetch = originalFetch;
  await rm(tmpConfig, { recursive: true, force: true });
  await rm(tmpCache, { recursive: true, force: true });
});

async function seedLoggedInProfile(name = "default"): Promise<void> {
  await setProfile(name, {
    instance: "https://app.example.com",
    userId: "u_1",
    email: "a@example.com",
  });
  await saveTokens(name, {
    accessToken: "tok-abc",
    expiresAt: Date.now() + 15 * 60 * 1000,
    refreshToken: "rt-xyz",
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

function sampleSchema() {
  return {
    openapi: "3.1.0",
    info: { title: "Appstrate", version: "1.0.0" },
    paths: {
      "/api/runs": {
        get: {
          operationId: "listRuns",
          summary: "List runs",
          tags: ["runs"],
          responses: { "200": { description: "OK" } },
        },
        post: {
          operationId: "createRun",
          summary: "Create a run",
          tags: ["runs"],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CreateRunRequest" } },
            },
          },
          responses: { "201": { description: "Created" } },
        },
      },
    },
    components: {
      schemas: {
        CreateRunRequest: {
          type: "object",
          properties: { agentId: { type: "string" } },
        },
      },
    },
  };
}

describe("openapi list", () => {
  it("prints a compact index for the active profile", async () => {
    await seedLoggedInProfile();
    installFetch(
      async () =>
        new Response(JSON.stringify(sampleSchema()), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"v1"' },
        }),
    );
    const { io, stdout } = createMemoryIO();
    await openapiListCommand({ profile: "default" }, io);
    const out = stdout();
    expect(out).toContain("GET");
    expect(out).toContain("/api/runs");
    expect(out).toContain("POST");
    expect(out).toContain("— List runs");
    expect(out).toContain("[runs]");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/api/openapi.json");
    expect(fetchCalls[0]!.headers.Authorization).toBe("Bearer tok-abc");
  });

  it("filters by tag (case-insensitive)", async () => {
    await seedLoggedInProfile();
    installFetch(
      async () =>
        new Response(JSON.stringify(sampleSchema()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { io, stdout } = createMemoryIO();
    await openapiListCommand({ profile: "default", tag: "RUNS" }, io);
    const out = stdout();
    expect(out).toContain("/api/runs");
  });

  it("emits JSON with --json", async () => {
    await seedLoggedInProfile();
    installFetch(
      async () =>
        new Response(JSON.stringify(sampleSchema()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { io, stdout } = createMemoryIO();
    await openapiListCommand({ profile: "default", json: true }, io);
    const out = stdout();
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("method");
    expect(parsed[0]).toHaveProperty("path");
  });

  it("prints a friendly message when filters exclude everything", async () => {
    await seedLoggedInProfile();
    installFetch(
      async () =>
        new Response(JSON.stringify(sampleSchema()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { io, stdout } = createMemoryIO();
    await openapiListCommand({ profile: "default", tag: "nonexistent" }, io);
    const out = stdout();
    expect(out).toMatch(/No operations match/);
  });

  it("exits 1 with an actionable error when the server returns 401", async () => {
    await seedLoggedInProfile();
    installFetch(async (url) => {
      // Reactive refresh also fails → doRefresh wipes credentials and
      // the original 401 bubbles up through apiFetch as an AuthError.
      if (url.includes("/api/auth/cli/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unauth" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { io, stderr } = createMemoryIO();
    let code: number | undefined;
    try {
      await openapiListCommand({ profile: "default" }, io);
    } catch (err) {
      if (err instanceof ExitError) code = err.code;
      else throw err;
    }
    expect(code).toBe(1);
    const err = stderr();
    expect(err).toMatch(/appstrate login --profile default/);
  });
});

describe("openapi show", () => {
  it("renders a single operation by operationId", async () => {
    await seedLoggedInProfile();
    installFetch(
      async () =>
        new Response(JSON.stringify(sampleSchema()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { io, stdout } = createMemoryIO();
    await openapiShowCommand("createRun", undefined, { profile: "default" }, io);
    const out = stdout();
    expect(out).toContain("POST /api/runs");
    expect(out).toContain("operationId: createRun");
    expect(out).toContain("Create a run");
    expect(out).toContain("Request body (required):");
  });

  it("renders by METHOD + path", async () => {
    await seedLoggedInProfile();
    installFetch(
      async () =>
        new Response(JSON.stringify(sampleSchema()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { io, stdout } = createMemoryIO();
    await openapiShowCommand("GET", "/api/runs", { profile: "default" }, io);
    const out = stdout();
    expect(out).toContain("GET /api/runs");
    expect(out).toContain("operationId: listRuns");
  });

  it("emits dereferenced JSON with --json", async () => {
    await seedLoggedInProfile();
    installFetch(
      async () =>
        new Response(JSON.stringify(sampleSchema()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { io, stdout } = createMemoryIO();
    await openapiShowCommand("createRun", undefined, { profile: "default", json: true }, io);
    const out = stdout();
    const parsed = JSON.parse(out);
    expect(parsed.method).toBe("POST");
    expect(parsed.path).toBe("/api/runs");
    // $ref to CreateRunRequest should be dereferenced — the actual
    // object should appear under content.application/json.schema
    const schema = parsed.operation.requestBody.content["application/json"].schema;
    expect(schema).toEqual({
      type: "object",
      properties: { agentId: { type: "string" } },
    });
  });

  it("falls back to the raw operation when dereference yields circular refs", async () => {
    // Build a schema where Category → properties.children → items → Category
    // (self-referential). SwaggerParser.dereference inlines this into a
    // real JS cycle; JSON.stringify would throw without the fallback.
    await seedLoggedInProfile();
    const recursiveSchema = {
      openapi: "3.1.0",
      info: { title: "T", version: "1" },
      paths: {
        "/api/categories": {
          get: {
            operationId: "listCategories",
            summary: "List categories",
            tags: ["categories"],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Category" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Category: {
            type: "object",
            properties: {
              id: { type: "string" },
              children: {
                type: "array",
                items: { $ref: "#/components/schemas/Category" },
              },
            },
          },
        },
      },
    };
    installFetch(
      async () =>
        new Response(JSON.stringify(recursiveSchema), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { io, stdout } = createMemoryIO();
    await openapiShowCommand("listCategories", undefined, { profile: "default", json: true }, io);
    const out = stdout();
    const parsed = JSON.parse(out);
    expect(parsed.method).toBe("GET");
    expect(parsed.path).toBe("/api/categories");
    // Either the fallback triggered (warning + raw $ref preserved) OR
    // swagger-parser declined to create a cycle and the $ref is still
    // printable — both outcomes are acceptable and neither crashes.
    expect(parsed.operation).toBeDefined();
  });

  it("exits 1 with an actionable hint when the operation is unknown", async () => {
    await seedLoggedInProfile();
    installFetch(
      async () =>
        new Response(JSON.stringify(sampleSchema()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { io, stderr } = createMemoryIO();
    let code: number | undefined;
    try {
      await openapiShowCommand("doesNotExist", undefined, { profile: "default" }, io);
    } catch (err) {
      if (err instanceof ExitError) code = err.code;
      else throw err;
    }
    expect(code).toBe(1);
    expect(stderr()).toMatch(/No operation matches/);
  });
});

describe("openapi export", () => {
  it("dumps the full schema to stdout by default", async () => {
    await seedLoggedInProfile();
    const schema = sampleSchema();
    installFetch(
      async () =>
        new Response(JSON.stringify(schema), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { io, stdout } = createMemoryIO();
    await openapiExportCommand({ profile: "default" }, io);
    const out = stdout();
    const parsed = JSON.parse(out);
    expect(parsed.openapi).toBe("3.1.0");
    expect(parsed.paths["/api/runs"].get.operationId).toBe("listRuns");
  });

  it("writes to file with -o / --output", async () => {
    await seedLoggedInProfile();
    const schema = sampleSchema();
    installFetch(
      async () =>
        new Response(JSON.stringify(schema), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const target = join(tmpCache, "schema.json");
    const { io, stdout, stderr } = createMemoryIO();
    await openapiExportCommand({ profile: "default", output: target }, io);
    const written = await readFile(target, "utf-8");
    const parsed = JSON.parse(written);
    expect(parsed.openapi).toBe("3.1.0");
    const err = stderr();
    expect(err).toMatch(/Wrote \d+ bytes/);
    // Nothing should leak to stdout when -o is set
    expect(stdout()).toBe("");
  });
});

describe("openapi — ETag revalidation across commands", () => {
  it("reuses cache across list → show invocations (304 on second hit)", async () => {
    await seedLoggedInProfile();
    const schema = sampleSchema();

    // First call: 200 + ETag, caches on disk
    installFetch(
      async () =>
        new Response(JSON.stringify(schema), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"v1"' },
        }),
    );
    await openapiListCommand({ profile: "default" }, createMemoryIO().io);
    expect(fetchCalls).toHaveLength(1);

    // Second invocation gets its own sink, so what we assert below is the
    // `show` output alone — the sink boundary is the segmentation that
    // clearing a shared buffer used to provide.
    fetchCalls = [];
    installFetch(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["If-None-Match"]).toBe('"v1"');
      return new Response(null, { status: 304 });
    });
    const { io: showIo, stdout: showStdout } = createMemoryIO();
    await openapiShowCommand("listRuns", undefined, { profile: "default" }, showIo);
    expect(fetchCalls).toHaveLength(1);
    expect(showStdout()).toContain("GET /api/runs");
  });

  it("--no-cache bypasses ETag revalidation entirely", async () => {
    await seedLoggedInProfile();
    const schema = sampleSchema();

    // Seed cache
    installFetch(
      async () =>
        new Response(JSON.stringify(schema), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"v1"' },
        }),
    );
    await openapiListCommand({ profile: "default" }, createMemoryIO().io);

    // Second invocation with --no-cache; server should NOT receive an
    // If-None-Match header. A fresh sink keeps the two invocations'
    // output separate without clearing shared state.
    fetchCalls = [];
    installFetch(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["If-None-Match"]).toBeUndefined();
      return new Response(JSON.stringify(schema), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await openapiListCommand({ profile: "default", noCache: true }, createMemoryIO().io);
    expect(fetchCalls).toHaveLength(1);
  });
});
