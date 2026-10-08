// SPDX-License-Identifier: Apache-2.0

/**
 * The jwt plugin stores each JWKS private key encrypted under the auth
 * secret and decrypts it at every sign. Through the options
 * `packages/db/src/auth.ts` builds from `BETTER_AUTH_SECRET` and
 * `BETTER_AUTH_SECRETS`, a stored key must stay signable across a rotation
 * (#1769): CLI tokens and OIDC JWTs all go through `signJWT`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { jwks } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { withAuthEnv } from "../../../../../../test/helpers/auth-env.ts";
import { getOidcAuthApi } from "../../../auth/api.ts";

const S0 = "s0-legacy-secret-at-least-32-chars-long";
const S1 = "s1-keyring-secret-at-least-32-chars-long";
const S2 = "s2-keyring-secret-at-least-32-chars-long";

async function signUnder(env: {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_SECRETS?: string;
}): Promise<string> {
  return withAuthEnv({ BETTER_AUTH_SECRETS: undefined, ...env }, async () => {
    const result = (await getOidcAuthApi().signJWT({
      body: { payload: { sub: "rotation-test" } },
      headers: new Headers(),
    })) as { token?: string };
    if (!result.token) throw new Error("signJWT returned no token");
    return result.token;
  });
}

async function storedPrivateKeys(): Promise<string[]> {
  const rows = await db.select({ privateKey: jwks.privateKey }).from(jwks);
  return rows.map((r) => r.privateKey);
}

describe("JWKS private keys across an auth-secret rotation", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("keeps signing with a key minted before the keyring existed", async () => {
    await signUnder({ BETTER_AUTH_SECRET: S0 });
    const [minted] = await storedPrivateKeys();
    expect(minted).toBeDefined();
    expect(minted!.startsWith('"$ba$')).toBe(false);

    expect(
      await signUnder({ BETTER_AUTH_SECRET: S0, BETTER_AUTH_SECRETS: `1:${S1}` }),
    ).toBeString();
    expect(
      await signUnder({ BETTER_AUTH_SECRET: S0, BETTER_AUTH_SECRETS: `2:${S2},1:${S1}` }),
    ).toBeString();
    expect(await storedPrivateKeys()).toEqual([minted!]);
  });

  it("keeps signing with a key minted under a version while that version stays listed", async () => {
    await signUnder({ BETTER_AUTH_SECRET: S0, BETTER_AUTH_SECRETS: `1:${S1}` });
    const [minted] = await storedPrivateKeys();
    expect(minted!.startsWith('"$ba$1$')).toBe(true);

    expect(
      await signUnder({ BETTER_AUTH_SECRET: S0, BETTER_AUTH_SECRETS: `2:${S2},1:${S1}` }),
    ).toBeString();
    await expect(
      signUnder({ BETTER_AUTH_SECRET: S0, BETTER_AUTH_SECRETS: `2:${S2}` }),
    ).rejects.toThrow(/decrypt private key/);
  });
});
