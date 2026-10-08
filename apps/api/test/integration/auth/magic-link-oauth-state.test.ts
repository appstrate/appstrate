// SPDX-License-Identifier: Apache-2.0

/**
 * GHSA-965c-763c-88jm: before better-auth 1.7.7 an OAuth sign-in `state` was
 * stored in the same verification namespace as a magic-link token, so anyone
 * could start a social sign-in carrying a victim's e-mail and redeem the
 * returned `state` at `/magic-link/verify` as that victim — no mailbox, no
 * provider round trip. The platform runs exactly the affected shape: magic
 * link on (SMTP configured), a social provider on, state kept in the database.
 * This replays the attack through the real routes.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { session } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { createTestUser } from "../../helpers/auth.ts";
import { useAuthEnv } from "../../helpers/auth-env.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { enableSmtpForSuite } from "../../helpers/smtp.ts";

const app = getTestApp();

describe("an OAuth sign-in state is not a magic link", () => {
  // Registered before `enableSmtpForSuite`, so its rebuild sees both.
  useAuthEnv({ GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret" });
  enableSmtpForSuite();

  beforeEach(async () => {
    await truncateAll();
  });

  it("signs nobody in when a social sign-in's state is redeemed at /magic-link/verify", async () => {
    const victim = await createTestUser({ emailVerified: true });
    await db.delete(session).where(eq(session.userId, victim.id));

    const started = await app.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        disableRedirect: true,
        callbackURL: "/",
        additionalData: { type: "magic-link", email: victim.email },
      }),
    });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    expect(state).toBeTruthy();

    const redeemed = await app.request(
      `/api/auth/magic-link/verify?token=${encodeURIComponent(state!)}&callbackURL=%2F`,
    );

    expect(redeemed.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(await db.select().from(session).where(eq(session.userId, victim.id))).toHaveLength(0);
  });
});
