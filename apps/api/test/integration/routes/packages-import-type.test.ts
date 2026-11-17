// SPDX-License-Identifier: Apache-2.0

/**
 * `?type=` on the import doors: an import made from one package type's page
 * refuses an archive of another type BEFORE anything is written, and a bundle
 * import says which type its root is.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { assertDbMissing } from "../../helpers/assertions.ts";
import { packages } from "@appstrate/db/schema";

const app = getTestApp();

const enc = (s: string) => new TextEncoder().encode(s);

const SKILL_MD = "---\nname: typed-skill\ndescription: A test skill.\n---\n\nBody.";

function skillArchive(): Uint8Array {
  return new Uint8Array(zipSync({ "SKILL.md": enc(SKILL_MD) }));
}

async function post(ctx: TestContext, path: string, bytes: Uint8Array, filename: string) {
  const form = new FormData();
  form.append("file", new File([bytes], filename));
  return app.request(path, { method: "POST", headers: authHeaders(ctx), body: form });
}

describe("import doors — ?type=", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "typedorg" });
  });

  it("imports when the archive is the type asked for", async () => {
    const res = await post(ctx, "/api/packages/import?type=skill", skillArchive(), "s.zip");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ type: "skill" });
  });

  it("refuses an archive of another type on /import and writes nothing", async () => {
    const res = await post(ctx, "/api/packages/import?type=agent", skillArchive(), "s.zip");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "unexpected_package_type",
      actual_type: "skill",
      expected_type: "agent",
    });
    await assertDbMissing(packages, eq(packages.id, `@${ctx.org.slug}/typed-skill`));
  });

  it("refuses an unknown type", async () => {
    const res = await post(ctx, "/api/packages/import?type=tool", skillArchive(), "s.zip");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
  });

  it("refuses a bundle whose root is another type, and names the root type otherwise", async () => {
    const packageId = `@${ctx.org.slug}/typed-skill`;
    const manifest = {
      name: packageId,
      version: "1.0.0",
      type: "skill",
      schema_version: "0.1",
      display_name: "Typed",
      author: "tester",
    };
    const afps = new Uint8Array(
      zipSync({ "manifest.json": enc(JSON.stringify(manifest)), "SKILL.md": enc(SKILL_MD) }),
    );

    const refused = await post(ctx, "/api/packages/import-bundle?type=agent", afps, "s.afps");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "unexpected_package_type" });
    await assertDbMissing(packages, eq(packages.id, packageId));

    const accepted = await post(ctx, "/api/packages/import-bundle?type=skill", afps, "s.afps");
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({
      root_package_id: packageId,
      root_type: "skill",
    });
  });
});
