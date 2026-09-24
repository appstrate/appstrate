// SPDX-License-Identifier: Apache-2.0

import { ifMatch } from "../../helpers/etag.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db, isEmbeddedDb, reservePgConnection } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { _resetStoreForTesting } from "@appstrate/db/storage";
import { _resetCacheForTesting } from "@appstrate/env";
import { zipArtifact } from "@appstrate/core/zip";
import { getTestApp } from "../../helpers/app.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import { apiIntegrationManifest, mcpServerManifest } from "../../helpers/integration-manifests.ts";
import { downloadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { CONFIG_BY_TYPE } from "../../../src/services/package-items/config.ts";
import { downloadVersionZip } from "../../../src/services/package-storage.ts";
import { unzipPackageArchive } from "../../../src/services/package-archive.ts";
import {
  computeHasUnpublishedChanges,
  getLatestVersionCreatedAt,
} from "../../../src/services/package-versions.ts";

const app = getTestApp();
const encoder = new TextEncoder();
const content = "---\nname: skill\ndescription: Creation storage regression\n---\n\nInstructions";
const types = ["agent", "skill", "integration", "mcp-server"] as const;
type PackageType = (typeof types)[number];

describe("package creation storage consistency", () => {
  let ctx: TestContext;
  let server: ReturnType<typeof Bun.serve>;
  let objects: Map<string, Uint8Array>;
  let beforePut: (key: string) => Promise<void>;
  let failDraft: boolean;
  let failVersionGet: boolean;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "create-storage" });
    objects = new Map();
    beforePut = async () => {};
    failDraft = false;
    failVersionGet = false;
    // A controlled S3 peer exercises the real storage adapter and route writer.
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const key = decodeURIComponent(new URL(request.url).pathname);
        if (request.method === "PUT") {
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (failDraft && key.includes("/library-packages/"))
            return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
          await beforePut(key);
          objects.set(key, bytes);
          return new Response(null, { status: 200 });
        }
        if (request.method === "DELETE") {
          objects.delete(key);
          return new Response(null, { status: 204 });
        }
        if (failVersionGet && key.includes("agent-packages/") && key.endsWith(".afps"))
          return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
        const bytes = objects.get(key);
        return bytes
          ? new Response(bytes)
          : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      },
    });
    savedEnv = {};
    const env = {
      S3_BUCKET: "create-test",
      S3_REGION: "us-east-1",
      S3_ENDPOINT: `http://127.0.0.1:${server.port}`,
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
    };
    for (const [key, value] of Object.entries(env)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    _resetCacheForTesting();
    _resetStoreForTesting();
  });

  afterEach(async () => {
    await server?.stop(true);
    for (const [key, value] of Object.entries(savedEnv ?? {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetCacheForTesting();
    _resetStoreForTesting();
  });

  function manifest(type: PackageType) {
    const name = `@create-storage/${type}`;
    return type === "mcp-server"
      ? mcpServerManifest({ name })
      : type === "integration"
        ? apiIntegrationManifest({ name, auths: { primary: { type: "api_key" } } })
        : {
            name,
            type,
            schema_version: "0.2",
            version: "1.0.0",
            display_name: "Storage test",
            description: "Creation storage regression",
          };
  }

  function archive(type: PackageType, notes = "initial") {
    return zipArtifact(
      {
        "manifest.json": encoder.encode(JSON.stringify(manifest(type))),
        ...(type === "skill" ? { "SKILL.md": encoder.encode(content) } : {}),
        ...(type === "mcp-server" ? { "main.js": encoder.encode("export {};") } : {}),
        "notes.txt": encoder.encode(notes),
      },
      6,
    );
  }

  function create(type: PackageType) {
    let body: string | FormData;
    if (type === "mcp-server") {
      body = new FormData();
      body.set("file", new File([archive(type)], "mcp-server.afps"));
    } else
      body = JSON.stringify({
        manifest: manifest(type),
        content: type === "skill" ? content : type === "agent" ? "Instructions" : "",
        operations: [
          { op: "write", path: "notes.txt", text: "initial" },
          { op: "write", path: "binary.bin", bytes_base64: "AP+A" },
        ],
      });
    return app.request(`/api/packages/${CONFIG_BY_TYPE[type].storageFolder}`, {
      method: "POST",
      headers: authHeaders(ctx),
      body,
    });
  }

  async function row(type: PackageType) {
    return (
      await db
        .select()
        .from(packages)
        .where(eq(packages.id, `@create-storage/${type}`))
    )[0];
  }

  function files(type: PackageType) {
    return downloadPackageFiles(
      CONFIG_BY_TYPE[type].storageFolder,
      ctx.orgId,
      `@create-storage/${type}`,
      undefined,
      "org",
    );
  }

  for (const type of types) {
    it(`${type}: rolls back failed storage and permits retry at the same name`, async () => {
      failDraft = true;
      expect((await create(type)).status).toBe(500);
      expect(await row(type)).toBeUndefined();
      expect(
        await db
          .select()
          .from(packageVersions)
          .where(eq(packageVersions.packageId, `@create-storage/${type}`)),
      ).toEqual([]);
      expect(await files(type)).toBeNull();
      failDraft = false;
      const retry = await create(type);
      expect(retry.status, await retry.clone().text()).toBe(201);
      const draft = await files(type);
      expect(new TextDecoder().decode(draft?.["notes.txt"])).toBe("initial");
      if (type !== "mcp-server")
        expect(draft?.["binary.bin"]).toEqual(new Uint8Array([0, 255, 128]));
      const published = unzipPackageArchive(
        (await downloadVersionZip(`@create-storage/${type}`, "1.0.0"))!,
      );
      expect(published["notes.txt"]).toEqual(draft!["notes.txt"]!);
    });
  }

  it.skipIf(isEmbeddedDb)(
    "hides the new row from concurrent editors until its archive is committed",
    async () => {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      beforePut = async (key) => {
        if (key.includes("/library-packages/")) {
          reached.resolve();
          await release.promise;
        }
      };
      const creation = create("skill");
      try {
        await reached.promise;
        expect(await row("skill")).toBeUndefined();
        const premature = await app.request("/api/packages/skills/@create-storage/skill", {
          method: "PATCH",
          headers: { ...authHeaders(ctx), ...ifMatch(1) },
          body: JSON.stringify({
            operations: [{ op: "write", path: "saved.txt", text: "new" }],
          }),
        });
        expect(premature.status).toBe(404);
        release.resolve();
        expect((await creation).status).toBe(201);
        const update = await app.request("/api/packages/skills/@create-storage/skill", {
          method: "PATCH",
          headers: { ...authHeaders(ctx), ...ifMatch((await row("skill"))!.lockVersion) },
          body: JSON.stringify({
            operations: [{ op: "write", path: "saved.txt", text: "new" }],
          }),
        });
        expect(update.status).toBe(200);
        expect(Object.keys((await files("skill"))!)).toEqual(
          expect.arrayContaining(["SKILL.md", "notes.txt", "saved.txt"]),
        );
      } finally {
        release.resolve();
        await creation;
      }
    },
  );

  it.skipIf(isEmbeddedDb)(
    "rejects an import that loses a concurrent create instead of overwriting the winner",
    async () => {
      const connection = (await reservePgConnection())!;
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      beforePut = async (key) => {
        if (key.includes("/library-packages/")) {
          reached.resolve();
          await release.promise;
        }
      };
      const creation = create("skill");
      let importing: Promise<Response> | undefined;
      try {
        await reached.promise;
        const body = new FormData();
        body.set("file", new File([archive("skill", "loser")], "skill.afps"));
        importing = Promise.resolve(
          app.request("/api/packages/import", {
            method: "POST",
            headers: authHeaders(ctx),
            body,
          }),
        );
        // Observe contention on the draft lock before letting the winner commit.
        let waiting = false;
        const until = Date.now() + 3000;
        while (Date.now() < until) {
          const rows =
            await connection.sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid::bigint = (hashtext('package-files:@create-storage/skill')::bigint & 4294967295)`;
          if (rows.length) {
            waiting = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(waiting).toBe(true);
        release.resolve();
        expect((await creation).status).toBe(201);
        const loser = await importing;
        expect(loser.status, await loser.clone().text()).toBe(409);
        expect(new TextDecoder().decode((await files("skill"))?.["notes.txt"])).toBe("initial");
      } finally {
        release.resolve();
        await creation;
        await importing;
        connection.release();
      }
    },
  );

  it.skipIf(isEmbeddedDb)(
    "retains an edit made while the initial immutable version is uploaded",
    async () => {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      beforePut = async (key) => {
        if (key.includes("/agent-packages/")) {
          reached.resolve();
          await release.promise;
        }
      };
      const creation = create("skill");
      try {
        await reached.promise;
        const draft = (await row("skill"))!;
        const update = await app.request("/api/packages/skills/@create-storage/skill", {
          method: "PATCH",
          headers: { ...authHeaders(ctx), ...ifMatch(draft.lockVersion) },
          body: JSON.stringify({
            operations: [{ op: "write", path: "notes.txt", text: "edited" }],
          }),
        });
        expect(update.status).toBe(200);
        release.resolve();
        expect((await creation).status).toBe(201);
        expect(new TextDecoder().decode((await files("skill"))?.["notes.txt"])).toBe("edited");
        const version = unzipPackageArchive((await downloadVersionZip(draft.id, "1.0.0"))!);
        expect(new TextDecoder().decode(version["notes.txt"])).toBe("initial");
        const updated = (await row("skill"))!;
        expect(
          computeHasUnpublishedChanges(
            updated.source,
            1,
            updated.updatedAt,
            await getLatestVersionCreatedAt(draft.id),
          ),
        ).toBe(true);
      } finally {
        release.resolve();
        await creation;
      }
    },
  );

  it("answers a storage fault on a published archive as 500, never as an unavailable artifact", async () => {
    expect((await create("agent")).status).toBe(201);
    const path = "/api/packages/agents/@create-storage/agent/versions/1.0.0";
    // Control: the same read succeeds while storage answers.
    expect((await app.request(path, { headers: authHeaders(ctx) })).status).toBe(200);

    // A denied GET is not an absent object: calling it `422 version_artifact_unavailable`
    // would tell the caller the published bytes are gone when storage merely failed.
    failVersionGet = true;
    const res = await app.request(path, { headers: authHeaders(ctx) });
    await expectProblem(res, 500, { code: "internal_error" });
  });
});
