// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `src/lib/applications.ts`. Mirror of `orgs.test.ts`:
 * the pure helpers (`resolveApplicationRef`, `findDefaultApplication`)
 * and the thin HTTP wrappers (`listApplications`, `createApplication`)
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
import {
  listApplications,
  createApplication,
  resolveApplicationRef,
  findDefaultApplication,
  type Application,
} from "../src/lib/applications.ts";

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
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-apps-"));
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
    orgId: "org_1",
  });
  await saveTokens(name, {
    accessToken: "tok-abc",
    expiresAt: Date.now() + 15 * 60 * 1000,
    refreshToken: "rt-xyz",
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

function appRow(overrides: Partial<Application> = {}): Application {
  return {
    id: "app_1",
    orgId: "org_1",
    name: "Default",
    isDefault: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("listApplications", () => {
  it("GETs /api/applications and returns the `data` array", async () => {
    await seedAuth();
    installFetch(async (url) => {
      expect(url).toBe("https://app.example.com/api/applications");
      return new Response(
        JSON.stringify({
          object: "list",
          data: [appRow({ id: "app_1", name: "Default", isDefault: true })],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const apps = await listApplications("default");
    expect(apps).toHaveLength(1);
    expect(apps[0]!.id).toBe("app_1");
    expect(fetchCalls[0]!.method ?? "GET").toBe("GET");
    // The pinned org is forwarded as X-Org-Id — listApplications is
    // org-scoped even though it doesn't require X-App-Id.
    expect(fetchCalls[0]!.headers["X-Org-Id"]).toBe("org_1");
  });

  it("returns an empty array when the server returns no applications", async () => {
    await seedAuth();
    installFetch(
      async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const apps = await listApplications("default");
    expect(apps).toEqual([]);
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
    await expect(listApplications("default")).rejects.toThrow(/Malformed list response/);
  });
});

describe("createApplication", () => {
  it("POSTs with the name and returns the created application", async () => {
    await seedAuth();
    installFetch(async (url, init) => {
      expect(url).toBe("https://app.example.com/api/applications");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: "Staging" });
      return new Response(
        JSON.stringify(appRow({ id: "app_2", name: "Staging", isDefault: false })),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    const app = await createApplication("default", "Staging");
    expect(app.id).toBe("app_2");
    expect(app.isDefault).toBe(false);
  });
});

describe("resolveApplicationRef", () => {
  const apps: Application[] = [
    appRow({ id: "app_1", name: "Default", isDefault: true }),
    appRow({ id: "app_2", name: "Staging", isDefault: false }),
  ];

  it("matches by exact id", () => {
    expect(resolveApplicationRef(apps, "app_2").name).toBe("Staging");
  });

  it("ignores surrounding whitespace", () => {
    expect(resolveApplicationRef(apps, "  app_1  ").id).toBe("app_1");
  });

  it("throws with the available apps (marked [default]) when ref is unknown", () => {
    try {
      resolveApplicationRef(apps, "app_999");
      throw new Error("expected resolveApplicationRef to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('No application matches "app_999"');
      expect(msg).toContain("app_1");
      expect(msg).toContain("[default]");
      expect(msg).toContain("app_2");
    }
  });

  it("rejects empty references", () => {
    expect(() => resolveApplicationRef(apps, "")).toThrow(/empty/);
    expect(() => resolveApplicationRef(apps, "   ")).toThrow(/empty/);
  });

  it("surfaces a dedicated message when the profile has zero apps", () => {
    expect(() => resolveApplicationRef([], "anything")).toThrow(/No applications found/);
  });
});

describe("findDefaultApplication", () => {
  it("returns the app marked isDefault", () => {
    const apps = [
      appRow({ id: "app_1", isDefault: false }),
      appRow({ id: "app_2", isDefault: true }),
    ];
    expect(findDefaultApplication(apps)?.id).toBe("app_2");
  });

  it("returns undefined when no app is marked default (defensive path)", () => {
    const apps = [appRow({ id: "app_1", isDefault: false })];
    expect(findDefaultApplication(apps)).toBeUndefined();
  });

  it("returns undefined on an empty list", () => {
    expect(findDefaultApplication([])).toBeUndefined();
  });
});
