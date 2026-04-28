// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `appstrate app` subcommand family (issue #217):
 * `list`, `current`, `switch`, `create`. Mirror of `org-command.test.ts`.
 * We call each subcommand directly — commander is not in the loop — so
 * injected `deps` (picker / create prompt) aren't bypassed by non-TTY
 * guards.
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
  appListCommand,
  appCurrentCommand,
  appSwitchCommand,
  appCreateCommand,
} from "../src/commands/app.ts";

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

import { ExitError } from "./helpers/process-exit.ts";

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

interface Responders {
  listApps?: () => Response;
  createApp?: (body: unknown) => Response;
}

function installFetch(responders: Responders): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method;
    const body = typeof init?.body === "string" ? init.body : undefined;
    fetchCalls.push({ url, method, body });
    if (url.endsWith("/api/applications") && method === "POST") {
      const parsed = body ? JSON.parse(body) : {};
      return (
        responders.createApp?.(parsed) ?? new Response("missing createApp stub", { status: 501 })
      );
    }
    if (url.endsWith("/api/applications")) {
      return responders.listApps?.() ?? new Response("missing listApps stub", { status: 501 });
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
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-app-cmd-"));
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

async function seedLoggedIn(appId?: string, profile = "default", orgId = "org_1"): Promise<void> {
  await setProfile(profile, {
    instance: "https://app.example.com",
    userId: "u_1",
    email: "alice@example.com",
    orgId,
    ...(appId ? { appId } : {}),
  });
  await saveTokens(profile, {
    accessToken: "tok-abc",
    expiresAt: Date.now() + 15 * 60 * 1000,
    refreshToken: "rt-xyz",
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

async function pinnedAppId(profile = "default"): Promise<string | undefined> {
  return (await readConfig()).profiles[profile]?.appId;
}

const twoApps = {
  object: "list",
  data: [
    {
      id: "app_1",
      orgId: "org_1",
      name: "Default",
      isDefault: true,
      createdAt: "t",
    },
    {
      id: "app_2",
      orgId: "org_1",
      name: "Staging",
      isDefault: false,
      createdAt: "t",
    },
  ],
};

// ── list ─────────────────────────────────────────────────────────────

describe("app list", () => {
  it("prints each app with a `*` marker on the pinned one and [default] tag", async () => {
    await seedLoggedIn("app_2");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify(twoApps), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await appListCommand({ profile: "default" });

    const out = stdoutChunks.join("");
    const lines = out.split("\n").filter((l) => l.length > 0);
    const defaultLine = lines.find((l) => l.includes("Default"));
    const stagingLine = lines.find((l) => l.includes("Staging"));
    expect(defaultLine).toBeDefined();
    expect(stagingLine).toBeDefined();
    // app_2 is pinned → starts with `*`; app_1 is not but is the default.
    expect(stagingLine!.startsWith("*")).toBe(true);
    expect(defaultLine!.startsWith(" ")).toBe(true);
    expect(defaultLine!).toContain("[default]");
    expect(stagingLine!).not.toContain("[default]");
  });

  it("prints a friendly message when the org has no applications", async () => {
    await seedLoggedIn();
    installFetch({
      listApps: () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await appListCommand({ profile: "default" });
    expect(stdoutChunks.join("")).toContain("(no applications)");
  });

  it("errors out when the profile is not logged in", async () => {
    await expect(appListCommand({ profile: "default" })).rejects.toBeInstanceOf(ExitError);
    expect(stderrChunks.join("")).toContain("not configured");
  });
});

// ── current ─────────────────────────────────────────────────────────

describe("app current", () => {
  it("prints the pinned app id to stdout", async () => {
    await seedLoggedIn("app_42");
    await appCurrentCommand({ profile: "default" });
    expect(stdoutChunks.join("").trim()).toBe("app_42");
  });

  it("exits 1 with a hint when no app is pinned", async () => {
    await seedLoggedIn();
    await expect(appCurrentCommand({ profile: "default" })).rejects.toBeInstanceOf(ExitError);
    expect(stderrChunks.join("")).toContain("No application pinned");
  });

  it("exits 1 when the profile is unconfigured", async () => {
    await expect(appCurrentCommand({ profile: "default" })).rejects.toBeInstanceOf(ExitError);
    expect(stderrChunks.join("")).toContain("Not logged in");
  });
});

// ── switch ───────────────────────────────────────────────────────────

describe("app switch", () => {
  it("pins the app matching the positional arg (by id)", async () => {
    await seedLoggedIn("app_1");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify(twoApps), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await appSwitchCommand({ profile: "default", ref: "app_2" });

    expect(await pinnedAppId()).toBe("app_2");
    expect(stdoutChunks.join("")).toContain('Pinned "Staging"');
  });

  it("uses the injected picker when no ref is passed", async () => {
    await seedLoggedIn("app_1");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify(twoApps), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    let seenCurrent: string | undefined;
    await appSwitchCommand(
      { profile: "default" },
      {
        pickApp: async (apps, current) => {
          seenCurrent = current;
          return apps[1]!;
        },
      },
    );

    expect(seenCurrent).toBe("app_1");
    expect(await pinnedAppId()).toBe("app_2");
  });

  it("exits 1 when no apps exist", async () => {
    await seedLoggedIn("app_1");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(appSwitchCommand({ profile: "default" })).rejects.toBeInstanceOf(ExitError);
    expect(stderrChunks.join("")).toContain("No applications");
  });

  it("exits with an error when the ref does not match any app", async () => {
    await seedLoggedIn("app_1");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify(twoApps), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(appSwitchCommand({ profile: "default", ref: "nope" })).rejects.toBeInstanceOf(
      ExitError,
    );
    expect(await pinnedAppId()).toBe("app_1"); // unchanged
  });

  it("exits with a hint when the picker returns null (non-TTY, no ref)", async () => {
    await seedLoggedIn("app_1");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify(twoApps), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(
      appSwitchCommand({ profile: "default" }, { pickApp: async () => null }),
    ).rejects.toBeInstanceOf(ExitError);
    expect(stderrChunks.join("")).toContain("non-TTY");
    expect(await pinnedAppId()).toBe("app_1"); // unchanged
  });
});

// ── create ──────────────────────────────────────────────────────────

describe("app create", () => {
  it("POSTs with the positional name + auto-pins", async () => {
    await seedLoggedIn();
    let createdBody: unknown;
    installFetch({
      createApp: (body) => {
        createdBody = body;
        return new Response(
          JSON.stringify({
            id: "app_new",
            orgId: "org_1",
            name: "Fresh",
            isDefault: false,
            createdAt: "t",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await appCreateCommand({ profile: "default", name: "Fresh" });

    expect(createdBody).toEqual({ name: "Fresh" });
    expect(await pinnedAppId()).toBe("app_new");
    expect(stdoutChunks.join("")).toContain('Created "Fresh"');
  });

  it("prompts via the injected creator when no name is passed", async () => {
    await seedLoggedIn();
    let createdBody: unknown;
    installFetch({
      createApp: (body) => {
        createdBody = body;
        return new Response(
          JSON.stringify({
            id: "app_new",
            orgId: "org_1",
            name: "Prompted",
            isDefault: false,
            createdAt: "t",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await appCreateCommand(
      { profile: "default" },
      {
        promptCreateApp: async () => ({ name: "Prompted" }),
      },
    );

    expect(createdBody).toEqual({ name: "Prompted" });
    expect(await pinnedAppId()).toBe("app_new");
  });

  it("exits with a hint when prompt is unavailable (non-TTY + no name)", async () => {
    await seedLoggedIn();
    installFetch({});

    await expect(
      appCreateCommand({ profile: "default" }, { promptCreateApp: async () => null }),
    ).rejects.toBeInstanceOf(ExitError);
    expect(stderrChunks.join("")).toContain("non-TTY");
  });

  it("requires login", async () => {
    await expect(appCreateCommand({ profile: "default", name: "X" })).rejects.toBeInstanceOf(
      ExitError,
    );
    expect(stderrChunks.join("")).toContain("not configured");
  });
});
