// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `commands/whoami.ts`.
 *
 * Contract we care about:
 *   1. A valid token + a server that returns a profile MUST produce a
 *      stdout summary keyed on the SERVER'S email — not the copy
 *      cached in `config.toml` at login time. If the user changed
 *      their email in the dashboard since last login, `whoami` must
 *      surface the fresh value.
 *   2. A server 401 (revoked / rotated / expired session) MUST route
 *      through the `AuthError` / `apiFetch` error path and produce a
 *      re-login hint on stderr + exit 1.
 *   3. Unconfigured profile → stderr error naming the missing
 *      profile + exit 1 (no network call).
 *   4. Unreachable server (e.g. wrong port, TCP reset) → stderr error
 *      + exit 1, local state unaffected.
 *
 * Pattern follows `logout.test.ts`: in-memory keyring + global fetch
 * stub + `XDG_CONFIG_HOME` pointed at a tmpdir. Uses an ephemeral
 * `Bun.serve()` only for the "unreachable" test (we close it and reuse
 * its port) — every other test runs through the fetch stub so we can
 * assert request shape without binding to a real socket.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { whoamiCommand } from "../src/commands/whoami.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";

type FetchCall = { url: string; method: string | undefined; auth: string | null };

const configHome = useTempConfigHome("appstrate-cli-whoami-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;

let fetchCalls: FetchCall[];

function installFetch(responder: (url: string, init?: RequestInit) => Promise<Response>): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({
      url,
      method: init?.method,
      auth: headers.Authorization ?? null,
    });
    return responder(url, init);
  };
  globalThis.fetch = stub as unknown as typeof fetch;
}

/**
 * Each test builds its own sink and injects it, so the captured bytes are
 * the command's and nobody else's. The previous harness reassigned the
 * process-wide streams; because `bun test` runs every package in one
 * process, that buffer also collected concurrent writes from other suites
 * and made `expect(...).toBe("")` a coin flip (issue #1180).
 *
 * `io.exit` throws `ExitError` instead of returning, so the rest of
 * `whoamiCommand` doesn't execute after what would have been a fatal exit
 * and the test worker survives. `whoamiCommand` only exits on its error
 * branches; the happy path returns normally.
 */
import { ExitError } from "./helpers/process-exit.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";

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

/**
 * The cached email is deliberately STALE: contract #1 is that `whoami` prints
 * the copy the SERVER returns, never the one `config.toml` kept from login.
 */
function seedStaleProfile(name: string): Promise<void> {
  return seedLoggedInProfile(name, { email: "stale@example.com" });
}

describe("whoami (happy path)", () => {
  it("prints the SERVER-returned email, not the cached config.toml email", async () => {
    // Seed with a deliberately stale email so we can tell which source
    // ended up on stdout.
    await seedStaleProfile("default");
    installFetch(async (url) => {
      expect(url).toBe("https://app.example.com/api/profile");
      return new Response(
        JSON.stringify({
          id: "u_1",
          displayName: "Alice",
          language: "en",
          email: "alice@example.com",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const { io, stdout, stderr } = createMemoryIO();
    await whoamiCommand({ profile: "default" }, io);

    const out = stdout();
    expect(out).toContain("Profile:  default");
    expect(out).toContain("Instance: https://app.example.com");
    // Server-side identity wins over the stale cached email.
    expect(out).toContain("User:     alice@example.com");
    expect(out).not.toContain("stale@example.com");
    expect(out).toContain("Name:     Alice");
    expect(stderr()).toBe("");
  });

  it("falls back to server `name` when `displayName` is null (fresh signup, no dashboard customization)", async () => {
    // A user who just signed up has `user.name` populated from the
    // signup form but has never set a `profiles.display_name`. Whoami
    // must still surface a Name line — the JWT carries `name`, but the
    // source of truth is the server response, so we read it back from
    // `/api/profile` rather than decoding the JWT a second time.
    await seedStaleProfile("default");
    installFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "u_1",
            displayName: null,
            language: "fr",
            email: "fresh@example.com",
            name: "Fresh User",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const { io, stdout } = createMemoryIO();
    await whoamiCommand({ profile: "default" }, io);

    const out = stdout();
    expect(out).toContain("Name:     Fresh User");
  });

  it("omits the Name line entirely when both displayName and name are null", async () => {
    await seedStaleProfile("default");
    installFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "u_1",
            displayName: null,
            language: "fr",
            email: "anon@example.com",
            name: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const { io, stdout } = createMemoryIO();
    await whoamiCommand({ profile: "default" }, io);

    const out = stdout();
    expect(out).not.toContain("Name:");
    // User line is still present — email is the stronger identity.
    expect(out).toContain("User:     anon@example.com");
  });

  it("enriches the Org line with name + id when the profile has an orgId pinned (issue #209)", async () => {
    await seedLoggedInProfile("default", { email: "alice@example.com", orgId: "org_42" });
    installFetch(async (url) => {
      if (url.endsWith("/api/profile")) {
        return new Response(
          JSON.stringify({ id: "u_1", displayName: "A", language: "en", email: "a@example.com" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/orgs")) {
        return new Response(
          JSON.stringify({
            object: "list",
            hasMore: false,
            data: [
              { id: "org_42", name: "Acme Corp", slug: "acme", role: "owner", createdAt: "t" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unknown", { status: 500 });
    });

    const { io, stdout } = createMemoryIO();
    await whoamiCommand({ profile: "default" }, io);

    const out = stdout();
    expect(out).toContain("Org:      Acme Corp (org_42)");
  });

  it("falls back to the bare orgId when the pinned org is not in the server list (stale pin)", async () => {
    await seedLoggedInProfile("default", { email: "alice@example.com", orgId: "org_gone" });
    installFetch(async (url) => {
      if (url.endsWith("/api/profile")) {
        return new Response(
          JSON.stringify({ id: "u_1", displayName: "A", language: "en", email: "a@example.com" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/orgs")) {
        return new Response(JSON.stringify({ object: "list", hasMore: false, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unknown", { status: 500 });
    });

    const { io, stdout } = createMemoryIO();
    await whoamiCommand({ profile: "default" }, io);
    expect(stdout()).toContain("Org:      org_gone");
  });

  it("sends the stored Bearer token on /api/profile (JWT path, not cookies)", async () => {
    await seedStaleProfile("default");
    installFetch(
      async () =>
        new Response(
          JSON.stringify({ id: "u_1", displayName: "A", language: "en", email: "a@example.com" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const { io } = createMemoryIO();
    await whoamiCommand({ profile: "default" }, io);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.auth).toBe("Bearer tok-abc");
  });
});

describe("whoami (error paths)", () => {
  it("reports a re-login hint and exits 1 when the server returns 401", async () => {
    await seedStaleProfile("default");
    installFetch(async (url) => {
      // /api/profile stays a 401; the reactive refresh also 401s with
      // invalid_grant so doRefresh wipes credentials and the original
      // 401 bubbles up as an AuthError.
      if (url.includes("/api/auth/cli/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { io, stdout, stderr } = createMemoryIO();
    let exitCode: number | undefined;
    try {
      await whoamiCommand({ profile: "default" }, io);
    } catch (err) {
      if (err instanceof ExitError) exitCode = err.code;
      else throw err;
    }

    expect(exitCode).toBe(1);
    const err = stderr();
    // AuthError message from `apiFetch` — user-actionable re-login hint.
    expect(err).toMatch(/appstrate login/);
    expect(stdout()).toBe("");
  });

  it("exits 1 with a 'Profile ... not configured' message when the profile doesn't exist (no network)", async () => {
    installFetch(async () => new Response("should not be reached", { status: 500 }));

    const { io, stderr } = createMemoryIO();
    let exitCode: number | undefined;
    try {
      await whoamiCommand({ profile: "ghost" }, io);
    } catch (err) {
      if (err instanceof ExitError) exitCode = err.code;
      else throw err;
    }

    expect(exitCode).toBe(1);
    expect(stderr()).toContain('Profile "ghost" not configured');
    expect(fetchCalls).toHaveLength(0);
  });

  it("exits 1 with an error message when the server is unreachable (fetch throws)", async () => {
    await seedStaleProfile("default");
    installFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const { io, stderr } = createMemoryIO();
    let exitCode: number | undefined;
    try {
      await whoamiCommand({ profile: "default" }, io);
    } catch (err) {
      if (err instanceof ExitError) exitCode = err.code;
      else throw err;
    }

    expect(exitCode).toBe(1);
    const err = stderr();
    // `formatError` passes plain `Error` through as .message.
    expect(err).toContain("fetch failed");
  });
});
