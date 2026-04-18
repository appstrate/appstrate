// SPDX-License-Identifier: Apache-2.0

/**
 * Brute-force lockout on `/device/approve` + `/device/deny`.
 *
 * Covers the attack surface described in migration 0004: an attacker
 * who has learned a valid `user_code` (leak, shoulder surf, partial
 * disclosure) should not be able to retry realm mismatches across many
 * accounts hoping to find one in the right audience. After
 * `MAX_APPROVE_ATTEMPTS` failed probes, the row must transition to
 * `status = 'denied'` so every subsequent approve — including the legit
 * user's — is refused.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user as userTable, session as sessionTable } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { ensureCliClient } from "../../../services/ensure-cli-client.ts";
import { deviceCode } from "../../../schema.ts";

const app = getTestApp({ modules: [oidcModule] });

async function signUpEndUser(email: string): Promise<string> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Sup3rSecretPass!", name: "T" }),
  });
  expect(res.status).toBe(200);
  const match = (res.headers.get("set-cookie") ?? "").match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  const cookie = `better-auth.session_token=${match[1]}`;
  const body = (await res.json()) as { user: { id: string } };
  // Force end-user realm so the approve realm guard refuses — every
  // attempt hits the counter path, not a BA state flip.
  await db
    .update(userTable)
    .set({ realm: "end_user:app_attacker" })
    .where(eq(userTable.id, body.user.id));
  await db
    .update(sessionTable)
    .set({ realm: "end_user:app_attacker" })
    .where(eq(sessionTable.userId, body.user.id));
  return cookie;
}

async function requestCode(): Promise<string> {
  const res = await app.request("/api/auth/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "appstrate-cli", scope: "openid" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { user_code: string }).user_code;
}

async function approve(userCode: string, cookie: string): Promise<number> {
  const res = await app.request("/api/auth/device/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ userCode }),
  });
  return res.status;
}

describe("device-flow brute-force lockout", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "bruteforce" });
    await ensureCliClient();
  });

  it("locks the row after 5 failed realm-mismatch approves", async () => {
    const cookie = await signUpEndUser("attacker@example.com");
    const userCode = await requestCode();
    const clean = userCode.replace(/-/g, "").toUpperCase();

    // First 5 attempts: guard increments + realm check rejects (403).
    for (let i = 0; i < 5; i++) {
      expect(await approve(userCode, cookie)).toBe(403);
      const [row] = await db
        .select({ status: deviceCode.status, attempts: deviceCode.attempts })
        .from(deviceCode)
        .where(eq(deviceCode.userCode, clean))
        .limit(1);
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(i + 1);
    }

    // 6th attempt: counter increments to 6 (> MAX=5), guard flips to
    // denied and throws access_denied BEFORE the realm check.
    expect(await approve(userCode, cookie)).toBe(403);
    const [locked] = await db
      .select({ status: deviceCode.status, attempts: deviceCode.attempts })
      .from(deviceCode)
      .where(eq(deviceCode.userCode, clean))
      .limit(1);
    expect(locked?.status).toBe("denied");
    expect(locked?.attempts).toBe(6);

    // 7th attempt: row is denied — guard short-circuits at the status
    // check, doesn't increment, and defers to BA's own error handler.
    // Counter stays at 6.
    await approve(userCode, cookie);
    const [final] = await db
      .select({ attempts: deviceCode.attempts })
      .from(deviceCode)
      .where(eq(deviceCode.userCode, clean))
      .limit(1);
    expect(final?.attempts).toBe(6);
  });

  it("does not count attempts when the user_code does not match a row", async () => {
    const cookie = await signUpEndUser("nomatch@example.com");
    await requestCode(); // issue SOME code so the table isn't empty
    const bogus = "ZZZZZZZZ";

    for (let i = 0; i < 10; i++) {
      await approve(bogus, cookie);
    }

    // No row with `ZZZZZZZZ` exists — the atomic UPDATE hit 0 rows and
    // the counter on the real row was untouched. This is the expected
    // behaviour: pure cold-brute-force of the 20⁸ user-code space is
    // defended by the per-IP rate limits, not by this row-level counter.
    const rows = await db.select({ attempts: deviceCode.attempts }).from(deviceCode);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(0);
  });
});
