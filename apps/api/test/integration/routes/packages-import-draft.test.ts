// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/packages/import?draft=true` — the upload becomes the draft, annex
 * files included, and nothing is published until the versions endpoint is
 * called. The write half of `appstrate skills sync --source draft`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { packageVersions } from "@appstrate/db/schema";

const app = getTestApp();
const enc = (s: string) => new TextEncoder().encode(s);

const PACKAGE_ID = "@draftorg/pdf-tools";

function skillZip(body: string, files: Record<string, string> = {}, version = "1.2.0"): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "manifest.json": enc(
      JSON.stringify({
        name: PACKAGE_ID,
        version,
        type: "skill",
        schema_version: "0.1",
        display_name: "PDF Tools",
      }),
    ),
    "SKILL.md": enc(`---\nname: pdf-tools\ndescription: Work with PDFs.\n---\n\n${body}\n`),
  };
  for (const [path, text] of Object.entries(files)) entries[path] = enc(text);
  return new Uint8Array(zipSync(entries));
}

async function importZip(ctx: TestContext, bytes: Uint8Array, query = "") {
  const formData = new FormData();
  formData.append("file", new File([bytes], "pdf-tools.afps"));
  return app.request(`/api/packages/import${query}`, {
    method: "POST",
    headers: authHeaders(ctx),
    body: formData,
  });
}

async function versionRows() {
  return db.select().from(packageVersions).where(eq(packageVersions.packageId, PACKAGE_ID));
}

/** Paths the draft file explorer lists. */
async function draftPaths(ctx: TestContext): Promise<string[]> {
  const res = await app.request(`/api/packages/${PACKAGE_ID}/files`, {
    headers: authHeaders(ctx),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries: { path: string }[] };
  return body.entries.map((e) => e.path).sort();
}

describe("POST /api/packages/import?draft=true", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "draftorg" });
  });

  it("creates the package as a draft, annex files included, and cuts no version", async () => {
    const res = await importZip(
      ctx,
      skillZip("Body one.", { "scripts/run.sh": "#!/bin/sh\necho one\n" }),
      "?draft=true",
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      packageId: PACKAGE_ID,
      type: "skill",
      draft: true,
      draftVersion: "1.2.0",
      lock_version: expect.any(Number),
    });

    expect(await versionRows()).toHaveLength(0);
    expect(await draftPaths(ctx)).toEqual(["SKILL.md", "manifest.json", "scripts/run.sh"]);
  });

  it("protects an unpublished draft, and replaces it under force — annex files too", async () => {
    expect((await importZip(ctx, skillZip("Body one."), "?draft=true")).status).toBe(201);

    const refused = await importZip(
      ctx,
      skillZip("Body two.", { "references/guide.md": "# Guide\n" }),
      "?draft=true",
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("draft_overwrite");

    const forced = await importZip(
      ctx,
      skillZip("Body two.", { "references/guide.md": "# Guide\n" }),
      "?draft=true&force=true",
    );
    expect(forced.status).toBe(201);

    expect(await versionRows()).toHaveLength(0);
    expect(await draftPaths(ctx)).toEqual(["SKILL.md", "manifest.json", "references/guide.md"]);
    const detail = await app.request(`/api/packages/skills/${PACKAGE_ID}`, {
      headers: authHeaders(ctx),
    });
    expect(((await detail.json()) as { content: string }).content).toContain("Body two.");
  });

  it("publishes the draft, annex files included, through the versions endpoint", async () => {
    expect(
      (
        await importZip(
          ctx,
          skillZip("Body one.", { "scripts/run.sh": "#!/bin/sh\necho one\n" }),
          "?draft=true",
        )
      ).status,
    ).toBe(201);

    const published = await app.request(`/api/packages/skills/${PACKAGE_ID}/versions`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(published.status).toBe(201);
    expect((await published.json()) as { version: string }).toMatchObject({ version: "1.2.0" });

    const rows = await versionRows();
    expect(rows).toHaveLength(1);

    const files = await app.request(`/api/packages/${PACKAGE_ID}/files?version=1.2.0`, {
      headers: authHeaders(ctx),
    });
    const body = (await files.json()) as { entries: { path: string }[] };
    expect(body.entries.map((e) => e.path).sort()).toEqual([
      "SKILL.md",
      "manifest.json",
      "scripts/run.sh",
    ]);
  });

  it("re-pushes without force when the client names the lock_version it last wrote", async () => {
    const first = await importZip(ctx, skillZip("Body one."), "?draft=true");
    expect(first.status).toBe(201);
    const { lock_version: lock } = (await first.json()) as { lock_version: number };
    expect(typeof lock).toBe("number");

    const second = await importZip(
      ctx,
      skillZip("Body two.", { "scripts/new.sh": "echo two\n" }),
      `?draft=true&lock_version=${lock}`,
    );
    expect(second.status).toBe(201);
    const { lock_version: next } = (await second.json()) as { lock_version: number };
    expect(next).toBeGreaterThan(lock);
    expect(await draftPaths(ctx)).toEqual(["SKILL.md", "manifest.json", "scripts/new.sh"]);

    // The stale lock now names a draft that no longer exists.
    const stale = await importZip(ctx, skillZip("Body three."), `?draft=true&lock_version=${lock}`);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("draft_overwrite");
  });

  it("refuses a lock that a chat edit has since moved past", async () => {
    const first = await importZip(ctx, skillZip("Body one."), "?draft=true");
    const { lock_version: lock } = (await first.json()) as { lock_version: number };

    // Someone edits the draft in the chat (the PUT route) in between.
    const edited = await app.request(`/api/packages/skills/${PACKAGE_ID}`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "---\nname: pdf-tools\ndescription: Work with PDFs.\n---\n\nChat edit.\n",
        lock_version: lock,
      }),
    });
    expect(edited.status).toBe(200);

    const push = await importZip(ctx, skillZip("Body two."), `?draft=true&lock_version=${lock}`);
    expect(push.status).toBe(409);
    expect(((await push.json()) as { code: string; detail: string }).detail).toContain(
      "edited elsewhere",
    );
    // force still wins, as before.
    expect(
      (await importZip(ctx, skillZip("Body two."), `?draft=true&lock_version=${lock}&force=true`))
        .status,
    ).toBe(201);
  });

  it("leaves a published version untouched when a later draft import replaces the files", async () => {
    expect((await importZip(ctx, skillZip("Body one.", {}, "1.0.0"))).status).toBe(201);
    expect(await versionRows()).toHaveLength(1);

    const res = await importZip(
      ctx,
      skillZip("Body two.", { "scripts/new.sh": "echo new\n" }, "1.0.1"),
      "?draft=true",
    );
    expect(res.status).toBe(201);

    expect(await versionRows()).toHaveLength(1);
    expect(await draftPaths(ctx)).toEqual(["SKILL.md", "manifest.json", "scripts/new.sh"]);
    const v1 = await app.request(`/api/packages/${PACKAGE_ID}/files?version=1.0.0`, {
      headers: authHeaders(ctx),
    });
    const body = (await v1.json()) as { entries: { path: string }[] };
    expect(body.entries.map((e) => e.path).sort()).toEqual(["SKILL.md", "manifest.json"]);
  });
});
