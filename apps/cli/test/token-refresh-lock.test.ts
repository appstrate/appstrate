// SPDX-License-Identifier: Apache-2.0

/**
 * Concurrent `appstrate` processes sharing one expired access token (issue
 * #1806): Claude Code's background `code sync` beside the user's own commands.
 *
 * Real child processes against a token endpoint that behaves like the
 * server's: a refresh token is redeemed once, and redeeming a used one revokes
 * the whole family. Without the cross-process lock every child presents the
 * same refresh token and the family dies; with it, exactly one redeems it and
 * the others pick up the rotated pair.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _setKeyringFactoryForTesting,
  loadTokens,
  PLATFORM_FAILURE_MARKER,
} from "../src/lib/keyring.ts";
import { seedLoggedInProfile } from "./helpers/auth-fixture.ts";

const CHILDREN = 4;
/** Holds each redemption open: every child reads the pair before the first one lands. */
const TOKEN_ENDPOINT_DELAY_MS = 250;

/** Bare specifiers in the modules a child imports resolve against `apps/cli`. */
const CLI_ROOT = join(import.meta.dir, "..");
const KEYRING_MODULE = join(CLI_ROOT, "src", "lib", "keyring.ts");
const API_MODULE = join(CLI_ROOT, "src", "lib", "api.ts");

/**
 * Forces the 0600 file store, in this process and in every child: a keyring
 * reporting no platform store is the documented fallback trigger, so nothing
 * reaches the developer's real OS keyring.
 */
function noOsKeyring(): never {
  throw new Error(`${PLATFORM_FAILURE_MARKER}no OS keyring in this test`);
}

/**
 * Imports first, then waits at the barrier, so all the children read their
 * stored pair within milliseconds of each other — well inside the endpoint's
 * delay — whatever their startup times.
 */
const CHILD_SCRIPT = `
const keyring = await import(${JSON.stringify(KEYRING_MODULE)});
keyring._setKeyringFactoryForTesting(() => {
  throw new Error(keyring.PLATFORM_FAILURE_MARKER + "no OS keyring in this test");
});
const { resolveAuthContext } = await import(${JSON.stringify(API_MODULE)});
await fetch(process.env.BARRIER_URL);
const { accessToken } = await resolveAuthContext("default");
process.stdout.write(accessToken);
`;

let root: string;
let originalConfigHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "appstrate-cli-refresh-lock-"));
  originalConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  _setKeyringFactoryForTesting(noOsKeyring);
});

afterEach(async () => {
  _setKeyringFactoryForTesting(null);
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  await rm(root, { recursive: true, force: true });
});

/** The server side of rotation: single-use refresh tokens, family revoked on reuse. */
function startTokenServer(barrierSize: number) {
  const state = { redemptions: 0, revoked: false, issued: 0 };
  const live = new Set(["rt-0"]);
  let arrived = 0;
  const allArrived = Promise.withResolvers<void>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/barrier") {
        if (++arrived === barrierSize) allArrived.resolve();
        await allArrived.promise;
        return new Response("go");
      }
      if (pathname !== "/api/auth/cli/token") return new Response("not found", { status: 404 });

      const form = new URLSearchParams(await req.text());
      const presented = form.get("refresh_token") ?? "";
      state.redemptions++;
      // Decided at arrival, answered after the delay: the race is in flight.
      const redeemable = !state.revoked && live.has(presented);
      if (redeemable) {
        live.delete(presented);
        state.issued++;
        live.add(`rt-${state.issued}`);
      } else {
        state.revoked = true;
        live.clear();
      }
      const issued = state.issued;
      await Bun.sleep(TOKEN_ENDPOINT_DELAY_MS);
      if (!redeemable) {
        return Response.json(
          { error: "invalid_grant", error_description: "Refresh token reuse detected." },
          { status: 400 },
        );
      }
      return Response.json({
        access_token: `at-${issued}`,
        refresh_token: `rt-${issued}`,
        token_type: "Bearer",
        expires_in: 900,
        refresh_expires_in: 2_592_000,
        scope: "openid",
      });
    },
  });
  return { server, state };
}

async function runChild(barrierUrl: string) {
  const proc = Bun.spawn([process.execPath, "-e", CHILD_SCRIPT], {
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      BARRIER_URL: barrierUrl,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("token refresh across processes", () => {
  it("redeems the refresh token once, however many processes find it expired", async () => {
    const { server, state } = startTokenServer(CHILDREN);
    try {
      const instance = `http://127.0.0.1:${server.port}`;
      await seedLoggedInProfile("default", {
        instance,
        tokens: { accessToken: "at-0", expiresAt: Date.now() - 60_000, refreshToken: "rt-0" },
      });

      const results = await Promise.all(
        Array.from({ length: CHILDREN }, () => runChild(`${instance}/barrier`)),
      );

      // Clean exits with nothing on stderr: no child saw an auth error.
      for (const { exitCode, stderr } of results) {
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      }
      expect(state).toEqual({ redemptions: 1, revoked: false, issued: 1 });
      expect(results.map((r) => r.stdout)).toEqual(Array(CHILDREN).fill("at-1"));
      const stored = await loadTokens("default");
      expect(stored).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
    } finally {
      await server.stop(true);
    }
  });
});
