// SPDX-License-Identifier: Apache-2.0

/**
 * A session cannot manage OAuth clients through Better Auth's client CRUD
 * (`/oauth2/create-client`, `get-client(s)`, `update-client`,
 * `client/rotate-secret`, `delete-client`). Platform clients are written by
 * `services/oauth-admin.ts` behind the org/space permission routes; a client
 * minted through Better Auth would carry no level confinement and the
 * signed-in user's full authority.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { oauthClient } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

describe("Better Auth OAuth client management by a session", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("refuses to create a client and stores none", async () => {
    const ctx = await createTestContext({ orgSlug: "clientpriv" });
    const res = await app.request("/api/auth/oauth2/create-client", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ctx.cookie },
      body: JSON.stringify({
        redirect_uris: ["https://evil.example.com/cb"],
        client_name: "Appstrate CLI",
      }),
    });

    expect(res.status).toBe(401);
    const rows = await db
      .select({ clientId: oauthClient.clientId })
      .from(oauthClient)
      .where(eq(oauthClient.name, "Appstrate CLI"));
    expect(rows).toHaveLength(0);
  });

  it("refuses to list clients", async () => {
    const ctx = await createTestContext({ orgSlug: "clientpriv-list" });
    const res = await app.request("/api/auth/oauth2/get-clients", {
      headers: { Cookie: ctx.cookie },
    });

    expect(res.status).toBe(401);
  });
});
