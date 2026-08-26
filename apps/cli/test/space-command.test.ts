// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `appstrate space` subcommand family (issue #217):
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
  spaceListCommand,
  spaceCurrentCommand,
  spaceSwitchCommand,
  spaceCreateCommand,
} from "../src/commands/space.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";

type FetchCall = { url: string; method: string | undefined; body?: string };

const configHome = useTempConfigHome("appstrate-cli-space-cmd-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;

let fetchCalls: FetchCall[];

import { ExitError } from "./helpers/process-exit.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";

interface Responders {
  listSpaces?: () => Response;
  createSpace?: (body: unknown) => Response;
}

function installFetch(responders: Responders): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method;
    const body = typeof init?.body === "string" ? init.body : undefined;
    fetchCalls.push({ url, method, body });
    if (url.endsWith("/api/spaces") && method === "POST") {
      const parsed = body ? JSON.parse(body) : {};
      return (
        responders.createSpace?.(parsed) ??
        new Response("missing createSpace stub", { status: 501 })
      );
    }
    if (url.endsWith("/api/spaces")) {
      return responders.listSpaces?.() ?? new Response("missing listSpaces stub", { status: 501 });
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

function seedLoggedIn(spaceId?: string, profile = "default", orgId = "org_1"): Promise<void> {
  return seedLoggedInProfile(profile, { email: "alice@example.com", orgId, spaceId });
}

async function pinnedSpaceId(profile = "default"): Promise<string | undefined> {
  return (await readConfig()).profiles[profile]?.spaceId;
}

const twoSpaces = {
  object: "list",
  data: [
    {
      id: "spc_1",
      orgId: "org_1",
      name: "Default",
      isDefault: true,
      createdAt: "t",
    },
    {
      id: "spc_2",
      orgId: "org_1",
      name: "Staging",
      isDefault: false,
      createdAt: "t",
    },
  ],
};

// ── list ─────────────────────────────────────────────────────────────

describe("space list", () => {
  it("prints each space with a `*` marker on the pinned one and [default] tag", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn("spc_2");
    installFetch({
      listSpaces: () =>
        new Response(JSON.stringify(twoSpaces), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await spaceListCommand({ profile: "default" }, io);

    const out = stdout();
    const lines = out.split("\n").filter((l) => l.length > 0);
    const defaultLine = lines.find((l) => l.includes("Default"));
    const stagingLine = lines.find((l) => l.includes("Staging"));
    expect(defaultLine).toBeDefined();
    expect(stagingLine).toBeDefined();
    // spc_2 is pinned → starts with `*`; spc_1 is not but is the default.
    expect(stagingLine!.startsWith("*")).toBe(true);
    expect(defaultLine!.startsWith(" ")).toBe(true);
    expect(defaultLine!).toContain("[default]");
    expect(stagingLine!).not.toContain("[default]");
  });

  it("prints a friendly message when the org has no spaces", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn();
    installFetch({
      listSpaces: () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await spaceListCommand({ profile: "default" }, io);
    expect(stdout()).toContain("(no spaces)");
  });

  it("errors out when the profile is not logged in", async () => {
    const { io, stderr } = createMemoryIO();
    await expect(spaceListCommand({ profile: "default" }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("not configured");
  });
});

// ── current ─────────────────────────────────────────────────────────

describe("space current", () => {
  it("prints the pinned space id to stdout", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn("spc_42");
    await spaceCurrentCommand({ profile: "default" }, io);
    expect(stdout().trim()).toBe("spc_42");
  });

  it("exits 1 with a hint when no space is pinned", async () => {
    const { io, stderr } = createMemoryIO();
    await seedLoggedIn();
    await expect(spaceCurrentCommand({ profile: "default" }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("No space pinned");
  });

  it("exits 1 when the profile is unconfigured", async () => {
    const { io, stderr } = createMemoryIO();
    await expect(spaceCurrentCommand({ profile: "default" }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("Not logged in");
  });
});

// ── switch ───────────────────────────────────────────────────────────

describe("space switch", () => {
  it("pins the space matching the positional arg (by id)", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn("spc_1");
    installFetch({
      listSpaces: () =>
        new Response(JSON.stringify(twoSpaces), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await spaceSwitchCommand({ profile: "default", ref: "spc_2" }, {}, io);

    expect(await pinnedSpaceId()).toBe("spc_2");
    expect(stdout()).toContain('Pinned "Staging"');
  });

  it("uses the injected picker when no ref is passed", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn("spc_1");
    installFetch({
      listSpaces: () =>
        new Response(JSON.stringify(twoSpaces), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    let seenCurrent: string | undefined;
    await spaceSwitchCommand(
      { profile: "default" },
      {
        pickSpace: async (spaces, current) => {
          seenCurrent = current;
          return spaces[1]!;
        },
      },
      io,
    );

    expect(seenCurrent).toBe("spc_1");
    expect(await pinnedSpaceId()).toBe("spc_2");
  });

  it("exits 1 when no spaces exist", async () => {
    const { io, stderr } = createMemoryIO();
    await seedLoggedIn("spc_1");
    installFetch({
      listSpaces: () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(spaceSwitchCommand({ profile: "default" }, {}, io)).rejects.toBeInstanceOf(
      ExitError,
    );
    expect(stderr()).toContain("No spaces");
  });

  it("exits with an error when the ref does not match any space", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn("spc_1");
    installFetch({
      listSpaces: () =>
        new Response(JSON.stringify(twoSpaces), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(
      spaceSwitchCommand({ profile: "default", ref: "nope" }, {}, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(await pinnedSpaceId()).toBe("spc_1"); // unchanged
  });

  it("exits with a hint when the picker returns null (non-TTY, no ref)", async () => {
    const { io, stderr } = createMemoryIO();
    await seedLoggedIn("spc_1");
    installFetch({
      listSpaces: () =>
        new Response(JSON.stringify(twoSpaces), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(
      spaceSwitchCommand({ profile: "default" }, { pickSpace: async () => null }, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("non-TTY");
    expect(await pinnedSpaceId()).toBe("spc_1"); // unchanged
  });
});

// ── create ──────────────────────────────────────────────────────────

describe("space create", () => {
  it("POSTs with the positional name + auto-pins", async () => {
    const { io, stdout } = createMemoryIO();
    await seedLoggedIn();
    let createdBody: unknown;
    installFetch({
      createSpace: (body) => {
        createdBody = body;
        return new Response(
          JSON.stringify({
            id: "spc_new",
            orgId: "org_1",
            name: "Fresh",
            isDefault: false,
            createdAt: "t",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await spaceCreateCommand({ profile: "default", name: "Fresh" }, {}, io);

    expect(createdBody).toEqual({ name: "Fresh" });
    expect(await pinnedSpaceId()).toBe("spc_new");
    expect(stdout()).toContain('Created "Fresh"');
  });

  it("prompts via the injected creator when no name is passed", async () => {
    const { io } = createMemoryIO();
    await seedLoggedIn();
    let createdBody: unknown;
    installFetch({
      createSpace: (body) => {
        createdBody = body;
        return new Response(
          JSON.stringify({
            id: "spc_new",
            orgId: "org_1",
            name: "Prompted",
            isDefault: false,
            createdAt: "t",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await spaceCreateCommand(
      { profile: "default" },
      {
        promptCreateSpace: async () => ({ name: "Prompted" }),
      },
      io,
    );

    expect(createdBody).toEqual({ name: "Prompted" });
    expect(await pinnedSpaceId()).toBe("spc_new");
  });

  it("exits with a hint when prompt is unavailable (non-TTY + no name)", async () => {
    const { io, stderr } = createMemoryIO();
    await seedLoggedIn();
    installFetch({});

    await expect(
      spaceCreateCommand({ profile: "default" }, { promptCreateSpace: async () => null }, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("non-TTY");
  });

  it("requires login", async () => {
    const { io, stderr } = createMemoryIO();
    await expect(
      spaceCreateCommand({ profile: "default", name: "X" }, {}, io),
    ).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toContain("not configured");
  });
});
