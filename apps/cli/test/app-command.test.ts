// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `appstrate app` subcommand family (issue #217):
 * `list`, `current`, `switch`, `create`. Mirror of `org-command.test.ts`.
 * We call each subcommand directly — commander is not in the loop — so
 * injected `deps` (picker / create prompt) aren't bypassed by non-TTY
 * guards.
 *
 * Output is captured through a per-test `createMemoryIO()` sink passed as the
 * command's trailing `io` argument, not by reassigning the global streams —
 * issue #1180.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readConfig } from "../src/lib/config.ts";
import {
  appListCommand,
  appCurrentCommand,
  appSwitchCommand,
  appCreateCommand,
} from "../src/commands/app.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";

type FetchCall = { url: string; method: string | undefined; body?: string };

const configHome = useTempConfigHome("appstrate-cli-app-cmd-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;

let fetchCalls: FetchCall[];

import { ExitError } from "./helpers/process-exit.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";

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

function seedLoggedIn(applicationId?: string, profile = "default", orgId = "org_1"): Promise<void> {
  return seedLoggedInProfile(profile, { email: "alice@example.com", orgId, applicationId });
}

async function pinnedAppId(profile = "default"): Promise<string | undefined> {
  return (await readConfig()).profiles[profile]?.applicationId;
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
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn("app_2");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify(twoApps), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await appListCommand({ profile: "default" }, io);

    const out = stdout();
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
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn();
    installFetch({
      listApps: () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await appListCommand({ profile: "default" }, io);
    expect(stdout()).toContain("(no applications)");
  });

  it("errors out when the profile is not logged in", async () => {
    const { io, stderr } = createMemoryIO();
    await expect(appListCommand({ profile: "default" }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("not configured");
  });
});

// ── current ─────────────────────────────────────────────────────────

describe("app current", () => {
  it("prints the pinned app id to stdout", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn("app_42");
    await appCurrentCommand({ profile: "default" }, io);
    expect(stdout().trim()).toBe("app_42");
  });

  it("exits 1 with a hint when no app is pinned", async () => {
    const { io, stderr } = createMemoryIO();
    await seedLoggedIn();
    await expect(appCurrentCommand({ profile: "default" }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("No application pinned");
  });

  it("exits 1 when the profile is unconfigured", async () => {
    const { io, stderr } = createMemoryIO();
    await expect(appCurrentCommand({ profile: "default" }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("Not logged in");
  });
});

// ── switch ───────────────────────────────────────────────────────────

describe("app switch", () => {
  it("pins the app matching the positional arg (by id)", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn("app_1");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify(twoApps), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await appSwitchCommand({ profile: "default", ref: "app_2" }, {}, io);

    expect(await pinnedAppId()).toBe("app_2");
    expect(stdout()).toContain('Pinned "Staging"');
  });

  it("uses the injected picker when no ref is passed", async () => {
    const { io } = createMemoryIO();
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
      io,
    );

    expect(seenCurrent).toBe("app_1");
    expect(await pinnedAppId()).toBe("app_2");
  });

  it("exits 1 when no apps exist", async () => {
    const { io, stderr } = createMemoryIO();
    await seedLoggedIn("app_1");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(appSwitchCommand({ profile: "default" }, {}, io)).rejects.toBeInstanceOf(
      ExitError,
    );
    expect(stderr()).toContain("No applications");
  });

  it("exits with an error when the ref does not match any app", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn("app_1");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify(twoApps), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(
      appSwitchCommand({ profile: "default", ref: "nope" }, {}, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(await pinnedAppId()).toBe("app_1"); // unchanged
  });

  it("exits with a hint when the picker returns null (non-TTY, no ref)", async () => {
    const { io, stderr } = createMemoryIO();
    await seedLoggedIn("app_1");
    installFetch({
      listApps: () =>
        new Response(JSON.stringify(twoApps), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(
      appSwitchCommand({ profile: "default" }, { pickApp: async () => null }, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("non-TTY");
    expect(await pinnedAppId()).toBe("app_1"); // unchanged
  });
});

// ── create ──────────────────────────────────────────────────────────

describe("app create", () => {
  it("POSTs with the positional name + auto-pins", async () => {
    const { io, stdout } = createMemoryIO();
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

    await appCreateCommand({ profile: "default", name: "Fresh" }, {}, io);

    expect(createdBody).toEqual({ name: "Fresh" });
    expect(await pinnedAppId()).toBe("app_new");
    expect(stdout()).toContain('Created "Fresh"');
  });

  it("prompts via the injected creator when no name is passed", async () => {
    const { io } = createMemoryIO();
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
      io,
    );

    expect(createdBody).toEqual({ name: "Prompted" });
    expect(await pinnedAppId()).toBe("app_new");
  });

  it("exits with a hint when prompt is unavailable (non-TTY + no name)", async () => {
    const { io, stderr } = createMemoryIO();
    await seedLoggedIn();
    installFetch({});

    await expect(
      appCreateCommand({ profile: "default" }, { promptCreateApp: async () => null }, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("non-TTY");
  });

  it("requires login", async () => {
    const { io, stderr } = createMemoryIO();
    await expect(
      appCreateCommand({ profile: "default", name: "X" }, {}, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("not configured");
  });
});
