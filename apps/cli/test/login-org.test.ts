// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the post-login org-pinning branch introduced by issue #209.
 *
 * Scope: only the branch that fires AFTER the device-flow token
 * exchange. We stub the device-flow endpoints minimally (just enough to
 * mint a JWT + refresh pair) so the suite can assert that:
 *   - one org → auto-pin
 *   - zero orgs → prompt create, POST /api/orgs, pin the result
 *   - ≥2 orgs → interactive picker result is pinned
 *   - `--org <id-or-slug>` → non-interactive, matches or fails
 *   - `--create-org <name>` → skips the list fetch entirely, POSTs
 *   - `--no-org` → skips the whole block, leaves orgId unset
 *   - non-TTY + ≥2 orgs → leaves orgId unset, prints hint
 *   - failure listing orgs does not fail the login
 *
 * Follows the same stdout-capture + tmp-XDG + FakeKeyring pattern as
 * `whoami.test.ts`. We inject the interactive prompts via `LoginDeps`
 * rather than replacing `@clack/prompts` globally (CLAUDE.md bans
 * `mock.module`).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _setKeyringFactoryForTesting,
  loadTokens,
  type KeyringHandle,
} from "../src/lib/keyring.ts";
import { readConfig } from "../src/lib/config.ts";
import { loginCommand } from "../src/commands/login.ts";
import type { Org } from "../src/lib/orgs.ts";
import type { Application } from "../src/lib/applications.ts";

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

type FetchCall = { url: string; method: string | undefined; body?: string };

let tmpDir: string;
let originalXdg: string | undefined;
const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

let fetchCalls: FetchCall[];
let stdoutChunks: string[];
let stderrChunks: string[];

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code}) called`);
  }
}

function captureIo(): void {
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number): never => {
    throw new ExitError(code ?? 0);
  }) as (code?: number) => never;
}

/**
 * Build a JWT with `sub` + `email` claims so `decodeAccessTokenIdentity`
 * succeeds. We don't sign — the CLI doesn't verify locally.
 */
function makeJwt(sub = "u_test", email = "alice@example.com"): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, email })).toString("base64url");
  return `${header}.${payload}.sig`;
}

interface ResponderMap {
  deviceCode?: () => Response;
  cliToken?: () => Response;
  listOrgs?: () => Response;
  createOrg?: (body: unknown) => Response;
  listApplications?: () => Response;
  createApplication?: (body: unknown) => Response;
}

function appRow(overrides: Partial<Application> = {}): Application {
  return {
    id: "app_default",
    orgId: "org_created",
    name: "Default",
    isDefault: true,
    createdAt: "t",
    ...overrides,
  };
}

function installDefaultResponders(overrides: ResponderMap = {}): void {
  const defaults: Required<ResponderMap> = {
    deviceCode: () =>
      new Response(
        JSON.stringify({
          device_code: "dc-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.example.com/device",
          verification_uri_complete: "https://app.example.com/device?code=ABCDEFGH",
          expires_in: 60,
          interval: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    cliToken: () =>
      new Response(
        JSON.stringify({
          access_token: makeJwt(),
          refresh_token: "rt-xyz",
          token_type: "Bearer",
          expires_in: 900,
          refresh_expires_in: 30 * 24 * 60 * 60,
          scope: "cli",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    listOrgs: () =>
      new Response(JSON.stringify({ organizations: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    createOrg: () =>
      new Response(
        JSON.stringify({
          id: "org_created",
          name: "Acme",
          slug: "acme",
          role: "owner",
          createdAt: "t",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    // By default, the app cascade sees a single default app — mirrors
    // the real server behavior where `POST /api/orgs` provisions one.
    // NOTE: the cascade only runs when an org is pinned. Test suites that
    // need the cascade to fire must either override `listOrgs` to return
    // a non-empty list, or pass `--create-org <name>`.
    listApplications: () =>
      new Response(JSON.stringify({ object: "list", data: [appRow()] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    createApplication: () =>
      new Response(JSON.stringify(appRow({ id: "app_forced", name: "Forced" })), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
  };
  const resolved = { ...defaults, ...overrides };

  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method;
    const body = typeof init?.body === "string" ? init.body : undefined;
    fetchCalls.push({ url, method, body });
    if (url.endsWith("/api/auth/device/code")) return resolved.deviceCode();
    if (url.endsWith("/api/auth/cli/token")) return resolved.cliToken();
    if (url.endsWith("/api/orgs") && method === "POST") {
      const parsed = body ? JSON.parse(body) : {};
      return resolved.createOrg(parsed);
    }
    if (url.endsWith("/api/orgs")) return resolved.listOrgs();
    if (url.endsWith("/api/applications") && method === "POST") {
      const parsed = body ? JSON.parse(body) : {};
      return resolved.createApplication(parsed);
    }
    if (url.endsWith("/api/applications")) return resolved.listApplications();
    return new Response("not mocked: " + url, { status: 501 });
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
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-login-org-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  FakeKeyring.store.clear();
  _setKeyringFactoryForTesting((p) => new FakeKeyring(p));
  fetchCalls = [];
  captureIo();
});

afterEach(async () => {
  _setKeyringFactoryForTesting(null);
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  (process as unknown as { exit: typeof originalExit }).exit = originalExit;
  await rm(tmpDir, { recursive: true, force: true });
});

async function readPinnedOrgId(profile = "default"): Promise<string | undefined> {
  const cfg = await readConfig();
  return cfg.profiles[profile]?.orgId;
}

async function readPinnedAppId(profile = "default"): Promise<string | undefined> {
  const cfg = await readConfig();
  return cfg.profiles[profile]?.appId;
}

describe("login org-pin branch", () => {
  it("auto-pins the single org when the user belongs to exactly one", async () => {
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_only", name: "Solo", slug: "solo", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
    });

    expect(await readPinnedOrgId()).toBe("org_only");
    const out = stdoutChunks.join("");
    expect(out).toContain('to "Solo"');
    expect(out).toContain("org_only");
  });

  it("uses the injected picker and persists the chosen org when ≥2 orgs", async () => {
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "Acme", slug: "acme", role: "owner", createdAt: "t" },
              { id: "org_2", name: "Beta", slug: "beta", role: "member", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    const orgsSeen: Org[][] = [];
    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
      deps: {
        pickOrg: async (orgs) => {
          orgsSeen.push(orgs);
          return orgs[1]!;
        },
      },
    });

    expect(await readPinnedOrgId()).toBe("org_2");
    expect(orgsSeen).toHaveLength(1);
    expect(orgsSeen[0]!.map((o) => o.id)).toEqual(["org_1", "org_2"]);
  });

  it("inline-creates an org when the user has none and accepts the prompt", async () => {
    let createBody: unknown;
    installDefaultResponders({
      createOrg: (body) => {
        createBody = body;
        return new Response(
          JSON.stringify({
            id: "org_new",
            name: "Fresh",
            slug: "fresh",
            role: "owner",
            createdAt: "t",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
      deps: {
        promptCreateOrg: async () => ({ name: "Fresh", slug: "fresh" }),
      },
    });

    expect(createBody).toEqual({ name: "Fresh", slug: "fresh" });
    expect(await readPinnedOrgId()).toBe("org_new");
  });

  it("honors --org <slug> and pins the matching org non-interactively", async () => {
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "Acme", slug: "acme", role: "owner", createdAt: "t" },
              { id: "org_2", name: "Beta", slug: "beta", role: "member", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
      org: "beta",
      // Picker should NOT be called when --org is provided.
      deps: {
        pickOrg: async () => {
          throw new Error("picker should not run");
        },
      },
    });

    expect(await readPinnedOrgId()).toBe("org_2");
  });

  it("honors --org <id> the same way as slug", async () => {
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "Acme", slug: "acme", role: "owner", createdAt: "t" },
              { id: "org_2", name: "Beta", slug: "beta", role: "member", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
      org: "org_1",
    });

    expect(await readPinnedOrgId()).toBe("org_1");
  });

  it("exits with an actionable error when --org <ref> does not match", async () => {
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "Acme", slug: "acme", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await expect(
      loginCommand({
        profile: "default",
        instance: "https://app.example.com",
        org: "does-not-exist",
      }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(await readPinnedOrgId()).toBeUndefined();
  });

  it("honors --create-org <name> without listing orgs first", async () => {
    let createBody: unknown;
    let listCalled = false;
    installDefaultResponders({
      listOrgs: () => {
        listCalled = true;
        return new Response(JSON.stringify({ organizations: [] }), { status: 200 });
      },
      createOrg: (body) => {
        createBody = body;
        return new Response(
          JSON.stringify({
            id: "org_forced",
            name: "Forced",
            slug: "forced",
            role: "owner",
            createdAt: "t",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
      createOrg: "Forced",
    });

    expect(listCalled).toBe(false);
    expect(createBody).toEqual({ name: "Forced" });
    expect(await readPinnedOrgId()).toBe("org_forced");
  });

  it("with --no-org skips the pin entirely, prints a hint, leaves orgId unset", async () => {
    let orgsCalled = false;
    installDefaultResponders({
      listOrgs: () => {
        orgsCalled = true;
        return new Response(JSON.stringify({ organizations: [] }), { status: 200 });
      },
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
      noOrg: true,
    });

    expect(orgsCalled).toBe(false);
    expect(await readPinnedOrgId()).toBeUndefined();
    expect(stdoutChunks.join("")).toContain("No org pinned");
  });

  it("tolerates a failing /api/orgs call — login succeeds unpinned", async () => {
    installDefaultResponders({
      listOrgs: () => new Response("boom", { status: 500 }),
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
    });

    expect(await readPinnedOrgId()).toBeUndefined();
    const tokens = await loadTokens("default");
    expect(tokens?.accessToken).toBeTruthy();
    expect(stderrChunks.join("")).toContain("Failed to list organizations");
    expect(stdoutChunks.join("")).toContain("No org pinned");
  });

  it("surfaces a POST /api/orgs failure when --create-org cannot proceed", async () => {
    installDefaultResponders({
      createOrg: () =>
        new Response(JSON.stringify({ message: "slug_taken" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(
      loginCommand({
        profile: "default",
        instance: "https://app.example.com",
        createOrg: "Acme",
      }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(await readPinnedOrgId()).toBeUndefined();
    // Tokens ARE persisted — the user can recover via `org switch` /
    // `org create` without re-running the device flow.
    const tokens = await loadTokens("default");
    expect(tokens?.accessToken).toBeTruthy();
  });

  it("preserves a prior orgId across a re-login when /api/orgs flakes (same user)", async () => {
    // First login — pin an org.
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_first", name: "First", slug: "first", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
    await loginCommand({ profile: "default", instance: "https://app.example.com" });
    expect(await readPinnedOrgId()).toBe("org_first");

    // Second login — /api/orgs errors out. Without preservation we'd
    // drop the pin silently.
    installDefaultResponders({
      listOrgs: () => new Response("boom", { status: 500 }),
    });
    await loginCommand({ profile: "default", instance: "https://app.example.com" });

    expect(await readPinnedOrgId()).toBe("org_first");
    expect(stderrChunks.join("")).toContain("Failed to list organizations");
  });

  it("does NOT preserve orgId when re-logging-in as a different user", async () => {
    // First login — user A pins an org.
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_A", name: "Alpha", slug: "alpha", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
    await loginCommand({ profile: "default", instance: "https://app.example.com" });
    expect(await readPinnedOrgId()).toBe("org_A");

    // Second login — same profile name, DIFFERENT user. /api/orgs
    // errors out so we'd fall through to preservation IF the userId
    // matched. It doesn't, so the stale org_A must NOT leak through.
    installDefaultResponders({
      cliToken: () =>
        new Response(
          JSON.stringify({
            access_token: makeJwt("u_OTHER", "bob@example.com"),
            refresh_token: "rt-xyz",
            token_type: "Bearer",
            expires_in: 900,
            refresh_expires_in: 30 * 24 * 60 * 60,
            scope: "cli",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      listOrgs: () => new Response("boom", { status: 500 }),
    });
    await loginCommand({ profile: "default", instance: "https://app.example.com" });

    expect(await readPinnedOrgId()).toBeUndefined();
  });

  it("writes orgId in addition to the pre-existing profile fields", async () => {
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_only", name: "Solo", slug: "solo", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
    });

    const cfg = await readConfig();
    const profile = cfg.profiles.default;
    expect(profile).toBeDefined();
    expect(profile!.instance).toBe("https://app.example.com");
    expect(profile!.email).toBe("alice@example.com");
    expect(profile!.userId).toBe("u_test");
    expect(profile!.orgId).toBe("org_only");
  });
});

// ─── App cascade (issue #217) ─────────────────────────────────────────
//
// Every org-pin outcome that leaves an `orgId` on the profile triggers
// a second fetch to `/api/applications` and re-pins the default app.
// The coverage below pairs with `login org-pin branch` above — it
// asserts the SAME flows, plus the app-specific escapes.

describe("login app-pin cascade", () => {
  // Shared: `listOrgs` returning exactly one org so the cascade has an
  // `orgId` to work with. Every test in this block inherits it unless it
  // overrides explicitly.
  const oneOrg = () =>
    new Response(
      JSON.stringify({
        organizations: [{ id: "org_1", name: "One", slug: "one", role: "owner", createdAt: "t" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("auto-pins the default application after org pin (one app)", async () => {
    installDefaultResponders({
      listOrgs: oneOrg,
      listApplications: () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [appRow({ id: "app_only", name: "Only", isDefault: true })],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
    });

    expect(await readPinnedAppId()).toBe("app_only");
    const out = stdoutChunks.join("");
    expect(out).toContain('/ app "Only"');
    expect(out).toContain("app_only");
  });

  it("pins the isDefault app when ≥2 applications exist", async () => {
    installDefaultResponders({
      listOrgs: oneOrg,
      listApplications: () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              appRow({ id: "app_staging", name: "Staging", isDefault: false }),
              appRow({ id: "app_default", name: "Default", isDefault: true }),
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await loginCommand({ profile: "default", instance: "https://app.example.com" });

    expect(await readPinnedAppId()).toBe("app_default");
  });

  it("warns on stderr and leaves appId unset when ≥2 apps but no default", async () => {
    installDefaultResponders({
      listOrgs: oneOrg,
      listApplications: () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              appRow({ id: "app_a", name: "A", isDefault: false }),
              appRow({ id: "app_b", name: "B", isDefault: false }),
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await loginCommand({ profile: "default", instance: "https://app.example.com" });

    expect(await readPinnedAppId()).toBeUndefined();
    expect(stderrChunks.join("")).toContain("none marked default");
    expect(stdoutChunks.join("")).toContain("No app pinned");
  });

  it("warns on stderr when the org has zero applications", async () => {
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "One", slug: "one", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      listApplications: () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await loginCommand({ profile: "default", instance: "https://app.example.com" });

    expect(await readPinnedAppId()).toBeUndefined();
    expect(stderrChunks.join("")).toContain("No applications found");
  });

  it("honors --app <id> for non-interactive pinning", async () => {
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "One", slug: "one", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      listApplications: () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              appRow({ id: "app_1", name: "One", isDefault: true }),
              appRow({ id: "app_2", name: "Two", isDefault: false }),
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
      app: "app_2",
    });

    expect(await readPinnedAppId()).toBe("app_2");
  });

  it("exits with an actionable error when --app <id> does not match", async () => {
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "One", slug: "one", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      listApplications: () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [appRow({ id: "app_1", isDefault: true })],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await expect(
      loginCommand({
        profile: "default",
        instance: "https://app.example.com",
        app: "app_does_not_exist",
      }),
    ).rejects.toBeInstanceOf(ExitError);
  });

  it("honors --create-app <name> and skips the list fetch", async () => {
    let createBody: unknown;
    let listCalled = false;
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "One", slug: "one", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      listApplications: () => {
        listCalled = true;
        return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
      },
      createApplication: (body) => {
        createBody = body;
        return new Response(
          JSON.stringify(appRow({ id: "app_forced", name: "Forced", isDefault: false })),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
      createApp: "Forced",
    });

    expect(listCalled).toBe(false);
    expect(createBody).toEqual({ name: "Forced" });
    expect(await readPinnedAppId()).toBe("app_forced");
  });

  it("with --no-app skips the app cascade entirely (no fetch, no hint)", async () => {
    let appsCalled = false;
    installDefaultResponders({
      listApplications: () => {
        appsCalled = true;
        return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
      },
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
      noApp: true,
    });

    expect(appsCalled).toBe(false);
    expect(await readPinnedAppId()).toBeUndefined();
    // No "No app pinned" hint when the user opted out.
    expect(stdoutChunks.join("")).not.toContain("No app pinned");
  });

  it("skips the app cascade when no org was pinned (no X-Org-Id to fetch with)", async () => {
    let appsCalled = false;
    installDefaultResponders({
      listApplications: () => {
        appsCalled = true;
        return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
      },
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
      noOrg: true,
    });

    expect(appsCalled).toBe(false);
    expect(await readPinnedAppId()).toBeUndefined();
    // The "No org pinned" hint fires; the app hint does not (skipped upstream).
    expect(stdoutChunks.join("")).toContain("No org pinned");
    expect(stdoutChunks.join("")).not.toContain("No app pinned");
  });

  it("tolerates a failing /api/applications call — login succeeds org-pinned but app-unpinned", async () => {
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "One", slug: "one", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      listApplications: () => new Response("boom", { status: 500 }),
    });

    await loginCommand({
      profile: "default",
      instance: "https://app.example.com",
    });

    expect(await readPinnedOrgId()).toBe("org_1");
    expect(await readPinnedAppId()).toBeUndefined();
    expect(stderrChunks.join("")).toContain("Failed to list applications");
  });

  it("preserves a prior appId across same-user re-login when /api/applications flakes", async () => {
    // First login — default-path cascade pins app_default via the
    // shared responder defaults.
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "One", slug: "one", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      listApplications: () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [appRow({ id: "app_pinned", name: "Pinned", isDefault: true })],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
    await loginCommand({ profile: "default", instance: "https://app.example.com" });
    expect(await readPinnedAppId()).toBe("app_pinned");

    // Second login — app fetch flakes. Without preservation we'd drop
    // the pin silently.
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [
              { id: "org_1", name: "One", slug: "one", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      listApplications: () => new Response("boom", { status: 500 }),
    });
    await loginCommand({ profile: "default", instance: "https://app.example.com" });

    expect(await readPinnedAppId()).toBe("app_pinned");
  });

  it("does NOT preserve appId when re-logging-in as a different user", async () => {
    // First login — user A pins.
    installDefaultResponders({
      listOrgs: () =>
        new Response(
          JSON.stringify({
            organizations: [{ id: "org_A", name: "A", slug: "a", role: "owner", createdAt: "t" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      listApplications: () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [appRow({ id: "app_A", isDefault: true })],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
    await loginCommand({ profile: "default", instance: "https://app.example.com" });
    expect(await readPinnedAppId()).toBe("app_A");

    // Second login — different user, network flakes. Preservation must not kick in.
    installDefaultResponders({
      cliToken: () =>
        new Response(
          JSON.stringify({
            access_token: makeJwt("u_OTHER", "bob@example.com"),
            refresh_token: "rt-xyz",
            token_type: "Bearer",
            expires_in: 900,
            refresh_expires_in: 30 * 24 * 60 * 60,
            scope: "cli",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      listOrgs: () => new Response("boom", { status: 500 }),
      listApplications: () => new Response("boom", { status: 500 }),
    });
    await loginCommand({ profile: "default", instance: "https://app.example.com" });

    expect(await readPinnedAppId()).toBeUndefined();
  });
});
