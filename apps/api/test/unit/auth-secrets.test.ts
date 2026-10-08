// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { authKeyring } from "../../src/lib/auth-secrets.ts";
import {
  headersWithAuthoritativePendingClient,
  readPendingClientCookieFromHeaders,
} from "../../src/modules/oidc/services/pending-client-cookie.ts";
import { useAuthEnv } from "../helpers/auth-env.ts";

const A = "a-secret-at-least-32-chars-long-for-hmac";
const B = "b-secret-at-least-32-chars-long-for-hmac";

describe("authKeyring", () => {
  const setEnv = useAuthEnv();

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
