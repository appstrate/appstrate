// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `src/lib/orgs.ts`. These cover the pure helpers
 * (`resolveOrgRef`) and the thin HTTP wrappers (`listOrgs`, `createOrg`)
 * via the same in-memory keyring + fetch-stub pattern used by the other
 * CLI tests. No real network, no real keyring.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _setKeyringFactoryForTesting,
  saveTokens,
  type KeyringHandle,
} from "../src/lib/keyring.ts";
import { setProfile } from "../src/lib/config.ts";
import { listOrgs, createOrg, resolveOrgRef, type Org } from "../src/lib/orgs.ts";

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

type FetchCall = {
  url: string;
  method: string | undefined;
  body?: string;
  headers: Record<string, string>;
};

let tmpDir: string;
let originalXdg: string | undefined;
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[];

function installFetch(responder: (url: string, init?: RequestInit) => Promise<Response>): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: string | undefined;
    if (typeof init?.body === "string") body = init.body;
    fetchCalls.push({ url, method: init?.method, body, headers });
    return responder(url, init);
  };
  globalThis.fetch = stub as unknown as typeof fetch;
}

beforeAll(() => {
  originalXdg = process.env.XDG_CONFIG_HOME;
});

afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-orgs-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  FakeKeyring.store.clear();
  _setKeyringFactoryForTesting((p) => new FakeKeyring(p));
  fetchCalls = [];
});

afterEach(async () => {
  _setKeyringFactoryForTesting(null);
  globalThis.fetch = originalFetch;
  await rm(tmpDir, { recursive: true, force: true });
});

async function seedAuth(name = "default"): Promise<void> {
  await setProfile(name, {
    instance: "https://app.example.com",
    userId: "u_1",
    email: "alice@example.com",
  });
  await saveTokens(name, {
    accessToken: "tok-abc",
    expiresAt: Date.now() + 15 * 60 * 1000,
    refreshToken: "rt-xyz",
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

describe("listOrgs", () => {
  it("GETs /api/orgs and returns the array", async () => {
    await seedAuth();
    installFetch(async (url) => {
      expect(url).toBe("https://app.example.com/api/orgs");
      return new Response(
        JSON.stringify({
          object: "list",
          hasMore: false,
          data: [{ id: "org_1", name: "Acme", slug: "acme", role: "owner", createdAt: "t" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const orgs = await listOrgs("default");
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.id).toBe("org_1");
    expect(fetchCalls[0]!.method ?? "GET").toBe("GET");
  });

  it("returns an empty array when the server returns no organizations", async () => {
    await seedAuth();
    installFetch(
      async () =>
        new Response(JSON.stringify({ object: "list", hasMore: false, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const orgs = await listOrgs("default");
    expect(orgs).toEqual([]);
  });

  it("throws when the response envelope is degenerate (missing data)", async () => {
    await seedAuth();
    installFetch(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    // Strict envelope: a 200 with no `data: [...]` is a server bug, not
    // a "no rows" signal — we surface it loudly via apiList rather than
    // silently returning [] (which used to mask broken servers).
    await expect(listOrgs("default")).rejects.toThrow(/Malformed list response/);
  });
});

describe("createOrg", () => {
  it("POSTs with only the name when slug is not provided", async () => {
    await seedAuth();
    installFetch(async (url, init) => {
      expect(url).toBe("https://app.example.com/api/orgs");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: "Acme" });
      return new Response(
        JSON.stringify({ id: "org_1", name: "Acme", slug: "acme", role: "owner", createdAt: "t" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    const org = await createOrg("default", { name: "Acme" });
    expect(org.id).toBe("org_1");
  });

  it("POSTs with name + slug when both are provided", async () => {
    await seedAuth();
    installFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: "Acme Corp", slug: "acme-corp" });
      return new Response(
        JSON.stringify({
          id: "org_2",
          name: "Acme Corp",
          slug: "acme-corp",
          role: "owner",
          createdAt: "t",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    const org = await createOrg("default", { name: "Acme Corp", slug: "acme-corp" });
    expect(org.slug).toBe("acme-corp");
  });

  it("omits an empty slug from the request body", async () => {
    await seedAuth();
    installFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect("slug" in body).toBe(false);
      return new Response(
        JSON.stringify({ id: "org_3", name: "X", slug: "x", role: "owner", createdAt: "t" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    await createOrg("default", { name: "X", slug: "" });
  });
});

describe("resolveOrgRef", () => {
  const orgs: Org[] = [
    { id: "org_1", name: "Acme", slug: "acme", role: "owner", createdAt: "t" },
    { id: "org_2", name: "Beta", slug: "beta", role: "member", createdAt: "t" },
  ];

  it("matches by exact id", () => {
    expect(resolveOrgRef(orgs, "org_2").name).toBe("Beta");
  });

  it("matches by exact slug", () => {
    expect(resolveOrgRef(orgs, "acme").name).toBe("Acme");
  });

  it("ignores surrounding whitespace", () => {
    expect(resolveOrgRef(orgs, "  acme  ").id).toBe("org_1");
  });

  it("throws with the available slugs/ids when ref is unknown", () => {
    expect(() => resolveOrgRef(orgs, "gamma")).toThrow(/No organization matches/);
  });

  it("rejects empty references", () => {
    expect(() => resolveOrgRef(orgs, "")).toThrow(/empty/);
    expect(() => resolveOrgRef(orgs, "   ")).toThrow(/empty/);
  });

  it("surfaces a dedicated message when the profile has zero orgs", () => {
    expect(() => resolveOrgRef([], "anything")).toThrow(/No organizations found/);
  });
});
