// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { authKeyring } from "../../src/lib/auth-secrets.ts";
import {
  headersWithAuthoritativePendingClient,
  readPendingClientCookieFromHeaders,
} from "../../src/modules/oidc/services/pending-client-cookie.ts";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";

const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS"] as const;
type AuthEnv = Record<(typeof ENV_KEYS)[number], string | undefined>;

const A = "a-secret-at-least-32-chars-long-for-hmac";
const B = "b-secret-at-least-32-chars-long-for-hmac";

function setEnv(vars: AuthEnv): void {
  for (const k of ENV_KEYS) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  resetEnvCache();
}

describe("authKeyring", () => {
  let snap: AuthEnv;

  beforeEach(() => {
    snap = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as AuthEnv;
  });

  afterEach(() => {
    setEnv(snap);
  });

  it("is BETTER_AUTH_SECRET alone when no list is set", () => {
    setEnv({ BETTER_AUTH_SECRET: A, BETTER_AUTH_SECRETS: undefined });
    expect(authKeyring()).toEqual([A]);
  });

  it("is the BETTER_AUTH_SECRETS values, current first, once a list is set", () => {
    setEnv({ BETTER_AUTH_SECRET: A, BETTER_AUTH_SECRETS: `2:${B},1:${A}` });
    expect(authKeyring()).toEqual([B, A]);
  });

  it("verifies a cookie signed under [A] with [B, A], not with [B] alone", () => {
    setEnv({ BETTER_AUTH_SECRET: B, BETTER_AUTH_SECRETS: `1:${A}` });
    const headers = headersWithAuthoritativePendingClient(new Headers(), "oauth_client");

    setEnv({ BETTER_AUTH_SECRET: B, BETTER_AUTH_SECRETS: `2:${B},1:${A}` });
    expect(readPendingClientCookieFromHeaders(headers)).toBe("oauth_client");

    setEnv({ BETTER_AUTH_SECRET: B, BETTER_AUTH_SECRETS: `2:${B}` });
    expect(readPendingClientCookieFromHeaders(headers)).toBeNull();
  });
});
