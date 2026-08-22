// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `appstrate org` subcommand family (issue #209):
 * `list`, `current`, `switch`, `create`. All tests run against a real
 * logged-in profile (seeded via `setProfile` + FakeKeyring) and a
 * stubbed `fetch` — we don't go through commander, we call each
 * subcommand function directly so the injected `deps` (picker / create
 * prompt) aren't bypassed by non-TTY guards.
 *
 * Output is captured through a per-test `createMemoryIO()` sink passed as the
 * command's trailing `io` argument. The suite used to reassign the *global*
 * `process.stdout.write` / `process.stderr.write` / `process.exit`, which made
 * every buffer assertion a claim about writes the test did not own — issue
 * #1180.
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
import { setProfile, readConfig } from "../src/lib/config.ts";
import {
  orgListCommand,
  orgCurrentCommand,
  orgSwitchCommand,
  orgCreateCommand,
} from "../src/commands/org.ts";

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

let fetchCalls: FetchCall[];

import { ExitError } from "./helpers/process-exit.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";

interface Responders {
  listOrgs?: () => Response;
  createOrg?: (body: unknown) => Response;
  listApplications?: () => Response;
}

function installFetch(responders: Responders): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method;
    const body = typeof init?.body === "string" ? init.body : undefined;
    fetchCalls.push({ url, method, body });
    if (url.endsWith("/api/orgs") && method === "POST") {
      const parsed = body ? JSON.parse(body) : {};
      return (
        responders.createOrg?.(parsed) ?? new Response("missing createOrg stub", { status: 501 })
      );
    }
    if (url.endsWith("/api/orgs")) {
      return responders.listOrgs?.() ?? new Response("missing listOrgs stub", { status: 501 });
    }
    if (url.endsWith("/api/applications")) {
      // Default: the new org has exactly one server-provisioned default app.
      return (
        responders.listApplications?.() ??
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "app_cascade_default",
                orgId: "org_2",
                name: "Default",
                isDefault: true,
                createdAt: "t",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      );
    }
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
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-org-cmd-"));
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

async function seedLoggedIn(
  orgId?: string,
  profile = "default",
  applicationId?: string,
): Promise<void> {
  await setProfile(profile, {
    instance: "https://app.example.com",
    userId: "u_1",
    email: "alice@example.com",
    ...(orgId ? { orgId } : {}),
    ...(applicationId ? { applicationId } : {}),
  });
  await saveTokens(profile, {
    accessToken: "tok-abc",
    expiresAt: Date.now() + 15 * 60 * 1000,
    refreshToken: "rt-xyz",
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

async function pinnedOrgId(profile = "default"): Promise<string | undefined> {
  return (await readConfig()).profiles[profile]?.orgId;
}

async function pinnedAppId(profile = "default"): Promise<string | undefined> {
  return (await readConfig()).profiles[profile]?.applicationId;
}

const twoOrgs = {
  object: "list",
  hasMore: false,
  data: [
    { id: "org_1", name: "Acme", slug: "acme", role: "owner", createdAt: "t" },
    { id: "org_2", name: "Beta", slug: "beta", role: "member", createdAt: "t" },
  ],
};

// ── list ─────────────────────────────────────────────────────────────

describe("org list", () => {
  it("prints each org with a `*` marker on the pinned one", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn("org_2");
    installFetch({
      listOrgs: () =>
        new Response(JSON.stringify(twoOrgs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await orgListCommand({ profile: "default" }, io);

    const out = stdout();
    expect(out).toContain("acme");
    expect(out).toContain("beta");
    // The pinned row is prefixed with `*`, the other with a space.
    // Don't trim — the non-pinned row's leading space is load-bearing.
    const lines = out.split("\n").filter((l) => l.length > 0);
    const beta = lines.find((l) => l.includes("beta"));
    const acme = lines.find((l) => l.includes("acme"));
    expect(beta).toBeDefined();
    expect(acme).toBeDefined();
    expect(beta!.startsWith("*")).toBe(true);
    expect(acme!.startsWith(" ")).toBe(true);
  });

  it("prints a friendly message when the profile has no orgs", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn();
    installFetch({
      listOrgs: () =>
        new Response(JSON.stringify({ object: "list", hasMore: false, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await orgListCommand({ profile: "default" }, io);
    expect(stdout()).toContain("(no organizations)");
  });

  it("errors out when the profile is not logged in", async () => {
    const { io, stderr } = createMemoryIO();
    await expect(orgListCommand({ profile: "default" }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("not configured");
  });
});

// ── current ─────────────────────────────────────────────────────────

describe("org current", () => {
  it("prints the pinned org id to stdout", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn("org_42");
    await orgCurrentCommand({ profile: "default" }, io);
    expect(stdout().trim()).toBe("org_42");
  });

  it("exits 1 with a hint when no org is pinned", async () => {
    const { io, stderr } = createMemoryIO();
    await seedLoggedIn();
    await expect(orgCurrentCommand({ profile: "default" }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("No organization pinned");
  });

  it("exits 1 when the profile is unconfigured", async () => {
    const { io, stderr } = createMemoryIO();
    await expect(orgCurrentCommand({ profile: "default" }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("Not logged in");
  });
});

// ── switch ───────────────────────────────────────────────────────────

describe("org switch", () => {
  it("pins the org matching the positional arg (by id)", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn("org_1");
    installFetch({
      listOrgs: () =>
        new Response(JSON.stringify(twoOrgs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await orgSwitchCommand({ profile: "default", ref: "org_2" }, {}, io);

    expect(await pinnedOrgId()).toBe("org_2");
    expect(stdout()).toContain('Pinned "Beta"');
  });

  it("pins the org matching the positional arg (by slug)", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn("org_1");
    installFetch({
      listOrgs: () =>
        new Response(JSON.stringify(twoOrgs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await orgSwitchCommand({ profile: "default", ref: "beta" }, {}, io);
    expect(await pinnedOrgId()).toBe("org_2");
  });

  it("uses the injected picker when no ref is passed", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn("org_1");
    installFetch({
      listOrgs: () =>
        new Response(JSON.stringify(twoOrgs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    let seenCurrent: string | undefined;
    await orgSwitchCommand(
      { profile: "default" },
      {
        pickOrg: async (orgs, current) => {
          seenCurrent = current;
          return orgs[1]!;
        },
      },
      io,
    );

    expect(seenCurrent).toBe("org_1");
    expect(await pinnedOrgId()).toBe("org_2");
  });

  it("exits 1 when no orgs exist", async () => {
    const { io, stderr } = createMemoryIO();
    await seedLoggedIn("org_1");
    installFetch({
      listOrgs: () =>
        new Response(JSON.stringify({ object: "list", hasMore: false, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(orgSwitchCommand({ profile: "default" }, {}, io)).rejects.toBeInstanceOf(
      ExitError,
    );
    expect(stderr()).toContain("No organizations");
  });

  it("exits with an error when the ref does not match any org", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn("org_1");
    installFetch({
      listOrgs: () =>
        new Response(JSON.stringify(twoOrgs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(
      orgSwitchCommand({ profile: "default", ref: "gamma" }, {}, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(await pinnedOrgId()).toBe("org_1"); // unchanged
  });
});

// ── create ──────────────────────────────────────────────────────────

describe("org create", () => {
  it("POSTs with the positional name + auto-pins", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn();
    let createdBody: unknown;
    installFetch({
      createOrg: (body) => {
        createdBody = body;
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

    await orgCreateCommand({ profile: "default", name: "Fresh" }, {}, io);

    expect(createdBody).toEqual({ name: "Fresh" });
    expect(await pinnedOrgId()).toBe("org_new");
    expect(stdout()).toContain('Created "Fresh"');
  });

  it("forwards --slug through the request body", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn();
    let createdBody: unknown;
    installFetch({
      createOrg: (body) => {
        createdBody = body;
        return new Response(
          JSON.stringify({
            id: "org_new",
            name: "Fresh",
            slug: "override",
            role: "owner",
            createdAt: "t",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await orgCreateCommand({ profile: "default", name: "Fresh", slug: "override" }, {}, io);
    expect(createdBody).toEqual({ name: "Fresh", slug: "override" });
  });

  it("prompts via the injected creator when no name is passed", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn();
    let createdBody: unknown;
    installFetch({
      createOrg: (body) => {
        createdBody = body;
        return new Response(
          JSON.stringify({
            id: "org_new",
            name: "Prompted",
            slug: "prompted",
            role: "owner",
            createdAt: "t",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await orgCreateCommand(
      { profile: "default" },
      {
        promptCreateOrg: async () => ({ name: "Prompted", slug: "prompted" }),
      },
      io,
    );

    expect(createdBody).toEqual({ name: "Prompted", slug: "prompted" });
    expect(await pinnedOrgId()).toBe("org_new");
  });

  it("requires login", async () => {
    const { io, stderr } = createMemoryIO();
    await expect(
      orgCreateCommand({ profile: "default", name: "X" }, {}, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("not configured");
  });
});

// ─── App cascade on org change (issue #217) ───────────────────────────
//
// An `applicationId` pinned to org A is invalid under org B — the server returns
// 404 on the next app-scoped call. `org switch` and `org create` must
// both (a) clear the stale app pin and (b) re-pin the new org's default
// app so `appstrate api` keeps working without manual intervention.

describe("org switch — cascade: re-pins new org's default app", () => {
  it("pins the new org AND pins the new org's default app in one call", async () => {
    const { io, stdout } = createMemoryIO();
    // Start pinned to org_1 with an app pin that only exists under org_1.
    await seedLoggedIn("org_1", "default", "app_stale_from_org_1");
    installFetch({
      listOrgs: () =>
        new Response(JSON.stringify(twoOrgs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      listApplications: () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "app_for_org_2",
                orgId: "org_2",
                name: "Org 2 Default",
                isDefault: true,
                createdAt: "t",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await orgSwitchCommand({ profile: "default", ref: "org_2" }, {}, io);

    expect(await pinnedOrgId()).toBe("org_2");
    expect(await pinnedAppId()).toBe("app_for_org_2");
    const out = stdout();
    expect(out).toContain('Pinned "Beta"');
    expect(out).toContain('/ app "Org 2 Default"');
  });

  it("clears the stale app pin even when the new org has no default app", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn("org_1", "default", "app_stale");
    installFetch({
      listOrgs: () =>
        new Response(JSON.stringify(twoOrgs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      listApplications: () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await orgSwitchCommand({ profile: "default", ref: "org_2" }, {}, io);

    expect(await pinnedOrgId()).toBe("org_2");
    // Crucially, the stale pin is gone even though no new default was found.
    expect(await pinnedAppId()).toBeUndefined();
  });

  it("tolerates a failing /api/applications call — org pin still commits", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn("org_1", "default", "app_stale");
    installFetch({
      listOrgs: () =>
        new Response(JSON.stringify(twoOrgs), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      listApplications: () => new Response("boom", { status: 500 }),
    });

    await orgSwitchCommand({ profile: "default", ref: "org_2" }, {}, io);

    expect(await pinnedOrgId()).toBe("org_2");
    expect(await pinnedAppId()).toBeUndefined();
  });
});

describe("org create — cascade: re-pins new org's default app", () => {
  it("pins the newly created org AND pins the auto-provisioned default app", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn(undefined, "default", "app_stale");
    installFetch({
      createOrg: () =>
        new Response(
          JSON.stringify({
            id: "org_new",
            name: "Fresh",
            slug: "fresh",
            role: "owner",
            createdAt: "t",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      listApplications: () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "app_new_default",
                orgId: "org_new",
                name: "Default",
                isDefault: true,
                createdAt: "t",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await orgCreateCommand({ profile: "default", name: "Fresh" }, {}, io);

    expect(await pinnedOrgId()).toBe("org_new");
    expect(await pinnedAppId()).toBe("app_new_default");
    expect(stdout()).toContain('/ app "Default"');
  });
});
