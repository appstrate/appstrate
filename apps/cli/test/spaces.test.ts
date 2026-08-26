// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `src/lib/spaces.ts`. Mirror of `orgs.test.ts`:
 * the pure helpers (`resolveSpaceRef`, `findDefaultSpace`)
 * and the thin HTTP wrappers (`listSpaces`, `createSpace`)
 * via the same in-memory keyring + fetch-stub pattern used by the other
 * CLI tests. No real network, no real keyring.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  listSpaces,
  createSpace,
  resolveSpaceRef,
  findDefaultSpace,
  type Space,
} from "../src/lib/spaces.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";

type FetchCall = {
  url: string;
  method: string | undefined;
  body?: string;
  headers: Record<string, string>;
};

const configHome = useTempConfigHome("appstrate-cli-spaces-");
let keyring: FakeKeyringInstall;
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

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  fetchCalls = [];
});

afterEach(async () => {
  keyring.restore();
  globalThis.fetch = originalFetch;
  await configHome.teardown();
});

function seedAuth(name = "default"): Promise<void> {
  return seedLoggedInProfile(name, { email: "alice@example.com", orgId: "org_1" });
}

function spaceRow(overrides: Partial<Space> = {}): Space {
  return {
    id: "spc_1",
    orgId: "org_1",
    name: "Default",
    isDefault: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("listSpaces", () => {
  it("GETs /api/spaces and returns the `data` array", async () => {
    await seedAuth();
    installFetch(async (url) => {
      expect(url).toBe("https://app.example.com/api/spaces");
      return new Response(
        JSON.stringify({
          object: "list",
          data: [spaceRow({ id: "spc_1", name: "Default", isDefault: true })],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const spaces = await listSpaces("default");
    expect(spaces).toHaveLength(1);
    expect(spaces[0]!.id).toBe("spc_1");
    expect(fetchCalls[0]!.method ?? "GET").toBe("GET");
    // The pinned org is forwarded as X-Org-Id — listSpaces is
    // org-scoped even though it doesn't require X-Space-Id.
    expect(fetchCalls[0]!.headers["X-Org-Id"]).toBe("org_1");
  });

  it("returns an empty array when the server returns no spaces", async () => {
    await seedAuth();
    installFetch(
      async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const spaces = await listSpaces("default");
    expect(spaces).toEqual([]);
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
    await expect(listSpaces("default")).rejects.toThrow(/Malformed list response/);
  });
});

describe("createSpace", () => {
  it("POSTs with the name and returns the created space", async () => {
    await seedAuth();
    installFetch(async (url, init) => {
      expect(url).toBe("https://app.example.com/api/spaces");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: "Staging" });
      return new Response(
        JSON.stringify(spaceRow({ id: "spc_2", name: "Staging", isDefault: false })),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    const space = await createSpace("default", "Staging");
    expect(space.id).toBe("spc_2");
    expect(space.isDefault).toBe(false);
  });
});

describe("resolveSpaceRef", () => {
  const spaces: Space[] = [
    spaceRow({ id: "spc_1", name: "Default", isDefault: true }),
    spaceRow({ id: "spc_2", name: "Staging", isDefault: false }),
  ];

  it("matches by exact id", () => {
    expect(resolveSpaceRef(spaces, "spc_2").name).toBe("Staging");
  });

  it("ignores surrounding whitespace", () => {
    expect(resolveSpaceRef(spaces, "  spc_1  ").id).toBe("spc_1");
  });

  it("throws with the available spaces (marked [default]) when ref is unknown", () => {
    try {
      resolveSpaceRef(spaces, "spc_999");
      throw new Error("expected resolveSpaceRef to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('No space matches "spc_999"');
      expect(msg).toContain("spc_1");
      expect(msg).toContain("[default]");
      expect(msg).toContain("spc_2");
    }
  });

  it("rejects empty references", () => {
    expect(() => resolveSpaceRef(spaces, "")).toThrow(/empty/);
    expect(() => resolveSpaceRef(spaces, "   ")).toThrow(/empty/);
  });

  it("surfaces a dedicated message when the profile has zero spaces", () => {
    expect(() => resolveSpaceRef([], "anything")).toThrow(/No spaces found/);
  });
});

describe("findDefaultSpace", () => {
  it("returns the space marked isDefault", () => {
    const spaces = [
      spaceRow({ id: "spc_1", isDefault: false }),
      spaceRow({ id: "spc_2", isDefault: true }),
    ];
    expect(findDefaultSpace(spaces)?.id).toBe("spc_2");
  });

  it("returns undefined when no space is marked default (defensive path)", () => {
    const spaces = [spaceRow({ id: "spc_1", isDefault: false })];
    expect(findDefaultSpace(spaces)).toBeUndefined();
  });

  it("returns undefined on an empty list", () => {
    expect(findDefaultSpace([])).toBeUndefined();
  });
});
