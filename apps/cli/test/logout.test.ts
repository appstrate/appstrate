// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `commands/logout.ts`.
 *
 * Contract we care about:
 *   1. Profiles MUST call `POST /api/auth/cli/revoke` so the
 *      refresh-token family is invalidated server-side. Otherwise a
 *      stolen keyring export would still be usable against the server
 *      after "logout".
 *   2. If the server is unreachable or returns a non-200, the local
 *      cleanup must still complete. A network partition must not leave
 *      the user locally logged in.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadTokens } from "../src/lib/keyring.ts";
import { getProfile } from "../src/lib/config.ts";
import { logoutCommand } from "../src/commands/logout.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";

type FetchCall = {
  url: string;
  method: string | undefined;
  auth: string | null;
  body: string | null;
};

const configHome = useTempConfigHome("appstrate-cli-logout-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[];
let dataHome: string;
let previousDataHome: string | undefined;

function installFetch(responder: (url: string, init?: RequestInit) => Promise<Response>): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : null;
    fetchCalls.push({
      url,
      method: init?.method,
      auth: headers.Authorization ?? null,
      body,
    });
    return responder(url, init);
  };
  // Bun's `typeof fetch` now includes a `preconnect` method we don't
  // need for the stub; cast through unknown so the type narrowing
  // doesn't force us to reimplement it.
  globalThis.fetch = stub as unknown as typeof fetch;
}

beforeEach(async () => {
  await configHome.setup();
  previousDataHome = process.env.XDG_DATA_HOME;
  dataHome = await mkdtemp(join(tmpdir(), "appstrate-logout-data-"));
  process.env.XDG_DATA_HOME = dataHome;
  keyring = installFakeKeyring();
  fetchCalls = [];
});

afterEach(async () => {
  keyring.restore();
  globalThis.fetch = originalFetch;
  await configHome.teardown();
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  await rm(dataHome, { recursive: true, force: true });
});

describe("logout (with refresh token)", () => {
  it("calls POST /api/auth/cli/revoke with refresh_token + client_id, then wipes state", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => new Response(JSON.stringify({ revoked: true }), { status: 200 }));

    await logoutCommand({ profile: "default" });

    // Contract #1 — family revocation happened server-side.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/api/auth/cli/revoke");
    expect(fetchCalls[0]!.method).toBe("POST");
    // Form-urlencoded body carries the refresh token + client id.
    const parsed = new URLSearchParams(fetchCalls[0]!.body ?? "");
    expect(parsed.get("token")).toBe("rt-xyz");
    expect(parsed.get("client_id")).toBe("appstrate-cli");
    // Revoke endpoint is unauthenticated (token proves ownership).
    expect(fetchCalls[0]!.auth).toBeNull();

    // Local cleanup happened too.
    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });

  it("still wipes local state when /cli/revoke fails (network error)", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await logoutCommand({ profile: "default" });

    expect(fetchCalls).toHaveLength(1);
    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });

  it("still wipes local state when /cli/revoke returns 500", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => new Response("oops", { status: 500 }));

    await logoutCommand({ profile: "default" });

    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });

  it("still wipes local state when /cli/revoke returns 401 (already revoked)", async () => {
    await seedLoggedInProfile("default");
    installFetch(
      async () =>
        new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await logoutCommand({ profile: "default" });

    // The 401 branch is benign — warn-and-continue.
    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });
});

describe("logout (idempotency)", () => {
  it("is idempotent when already logged out (no tokens, no profile)", async () => {
    installFetch(async () => new Response("", { status: 200 }));
    await logoutCommand({ profile: "never-logged-in" });
    expect(fetchCalls).toHaveLength(0);
  });
});

it("removes credentials even when the synchronization lock cannot be opened", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { getLockPath } = await import("../src/lib/skills-sync/lock.ts");
  const { createMemoryIO } = await import("./helpers/memory-io.ts");
  await seedLoggedInProfile("default");
  await mkdir(getLockPath(), { recursive: true });
  const { io, stderr } = createMemoryIO();
  await logoutCommand({}, io);
  expect(await loadTokens("default")).toBeNull();
  expect(await getProfile("default")).toBeNull();
  expect(stderr()).toContain("could not complete skills cleanup");
});
