// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate packages pull | status | push | publish`, end to end minus the
 * network.
 *
 * The commands are called directly with a per-test `createMemoryIO()` sink, a
 * throw-away `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `HOME`, and `globalThis.fetch`
 * stubbed by a small table-driven stand-in for the package routes (the
 * `skills-server.ts` approach), so the CLI's auth pipeline stays in the path.
 * The stand-in is strict where the real routes are: the draft routes answer
 * only in the home space, a published download only in a space that reads the
 * package, and the draft `PUT` refuses a stale `lock_version` with `409`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeIntegrity } from "@appstrate/core/integrity";
import { unzipArtifact, zipArtifact } from "@appstrate/core/zip";
import type { PackageType } from "@appstrate/core/validation";
import {
  packagesPublishCommand,
  packagesPullCommand,
  packagesPushCommand,
  packagesStatusCommand,
} from "../src/commands/packages.ts";
import { readLock } from "../src/lib/packages.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { ExitError } from "./helpers/process-exit.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SEGMENT: Record<PackageType, string> = {
  skill: "skills",
  agent: "agents",
  integration: "integrations",
  "mcp-server": "mcp-servers",
};

/** Path → text, or bytes for what a push sent as base64. */
type Tree = Record<string, string | Uint8Array>;

interface FakePackage {
  id: string;
  type: PackageType;
  homeSpaceId: string | null;
  writable: boolean;
  readSpaceIds: string[];
  draft: {
    lock: number;
    manifest: Record<string, unknown>;
    files: Tree;
    /** `has_unarchived_changes` on the detail; the draft moved since `latest` unless `false`. */
    unpublished?: boolean;
  };
  /** Published versions, oldest first; the last one is `latest`. */
  published: { version: string; files: Tree }[];
  /** Problem `code` the version POST answers with instead of publishing. */
  publishError?: { status: number; code: string };
}

interface Seen {
  method: string;
  path: string;
  spaceId: string | null;
  body?: unknown;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const problem = (status: number, code: string, detail: string): Response =>
  json({ type: "about:blank", title: code, status, detail, code }, status);

function zipOf(files: Tree): Uint8Array {
  return zipArtifact(
    Object.fromEntries(
      Object.entries(files).map(([p, t]) => [p, typeof t === "string" ? encoder.encode(t) : t]),
    ),
  );
}

function createPackageServer(packages: FakePackage[]) {
  const seen: Seen[] = [];
  const byId = (scope: string, name: string) =>
    packages.find((p) => p.id === `${decodeURIComponent(scope)}/${decodeURIComponent(name)}`);
  const draftTree = (p: FakePackage) => ({
    "manifest.json": JSON.stringify(p.draft.manifest),
    ...p.draft.files,
  });

  const respond = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const spaceId = new Headers(init?.headers).get("X-Space-Id");
    const entry: Seen = { method, path: `${path}${url.search}`, spaceId };
    seen.push(entry);

    if (path === "/api/orgs") {
      return json({
        object: "list",
        data: [{ id: "org_1", name: "Acme", slug: "acme", role: "owner", createdAt: "t" }],
      });
    }

    if (path === "/api/packages/import" && method === "POST") {
      const form = init!.body as FormData;
      const file = form.get("file") as File;
      entry.body = { fileName: file.name };
      const tree = unzipArtifact(new Uint8Array(await file.arrayBuffer()));
      const files = Object.fromEntries(
        Object.entries(tree).map(([p, bytes]) => [p, decoder.decode(bytes)]),
      );
      let manifest: Record<string, unknown>;
      if (files["manifest.json"]) manifest = JSON.parse(files["manifest.json"]);
      else {
        const name = /name:\s*(\S+)/.exec(files["SKILL.md"] ?? "")?.[1];
        manifest = { name: `@acme/${name}`, type: "skill", version: "1.0.0" };
      }
      delete files["manifest.json"];
      const created: FakePackage = {
        id: manifest.name as string,
        type: manifest.type as PackageType,
        homeSpaceId: spaceId,
        writable: true,
        readSpaceIds: spaceId ? [spaceId] : [],
        draft: { lock: 1, manifest, files },
        published: [{ version: manifest.version as string, files: { ...files } }],
      };
      packages.push(created);
      return json({ packageId: created.id, type: created.type, version: manifest.version }, 201);
    }

    const home = path.match(/^\/api\/packages\/(@[^/]+)\/([^/]+)\/home$/);
    if (home) {
      const p = byId(home[1]!, home[2]!);
      if (!p) return problem(404, "package_not_found", "Package not found");
      return json({
        id: p.id,
        type: p.type,
        home_space_id: p.homeSpaceId,
        home_writable: p.writable,
        home_deletable: p.writable,
        home_shareable: p.writable,
        read_space_ids: p.readSpaceIds,
      });
    }

    const draftDownload = path.match(/^\/api\/packages\/(@[^/]+)\/([^/]+)\/draft\/download$/);
    if (draftDownload) {
      const p = byId(draftDownload[1]!, draftDownload[2]!);
      if (!p || spaceId !== p.homeSpaceId) return problem(404, "package_not_found", "Not here");
      if (!p.writable) return problem(403, "draft_not_writable", "Not yours");
      return new Response(new Uint8Array(zipOf(draftTree(p))), {
        headers: { "Content-Type": "application/zip", ETag: `"d${p.draft.lock}"` },
      });
    }

    const download = path.match(/^\/api\/packages\/(@[^/]+)\/([^/]+)\/([^/]+)\/download$/);
    if (download) {
      const p = byId(download[1]!, download[2]!);
      const reads = p && (spaceId === p.homeSpaceId || p.readSpaceIds.includes(spaceId ?? ""));
      if (!p || !reads) return problem(404, "package_not_found", "Not here");
      const spec = decodeURIComponent(download[3]!);
      const version =
        spec === "latest" ? p.published.at(-1) : p.published.find((v) => v.version === spec);
      if (!version) return problem(404, "version_not_found", "No such version");
      const bytes = zipOf({
        "manifest.json": JSON.stringify({ ...p.draft.manifest, version: version.version }),
        RECORD: "manifest.json,sha256-x,1",
        ...version.files,
      });
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "application/zip", "X-Integrity": computeIntegrity(bytes) },
      });
    }

    const typed = path.match(
      /^\/api\/packages\/([a-z-]+)\/(@[^/]+)\/([^/]+)(\/versions(?:\/info)?)?$/,
    );
    if (typed) {
      const p = byId(typed[2]!, typed[3]!);
      if (!p || SEGMENT[p.type] !== typed[1] || spaceId !== p.homeSpaceId) {
        return problem(404, "package_not_found", "Not here");
      }
      const tail = typed[4];
      if (!tail && method === "GET") {
        return json({
          id: p.id,
          lock_version: p.draft.lock,
          manifest: p.draft.manifest,
          has_unarchived_changes: p.draft.unpublished ?? true,
        });
      }
      if (!tail && method === "PUT") {
        const body = JSON.parse(init!.body as string) as {
          lock_version: number;
          manifest?: Record<string, unknown>;
          operations?: (
            | { op: "write"; path: string; text?: string; bytes_base64?: string }
            | {
                op: "delete";
                path: string;
              }
          )[];
        };
        entry.body = body;
        if (body.lock_version !== p.draft.lock) {
          return problem(409, "conflict", "The package was modified since you loaded it");
        }
        for (const op of body.operations ?? []) {
          if (op.op === "delete") delete p.draft.files[op.path];
          else {
            p.draft.files[op.path] =
              op.text ?? new Uint8Array(Buffer.from(op.bytes_base64!, "base64"));
          }
        }
        // The route stores the VALIDATED manifest, which may differ from the one sent.
        if (body.manifest) p.draft.manifest = { ...body.manifest, schema_version: "1.0" };
        p.draft.lock += 1;
        return json({ id: p.id, lock_version: p.draft.lock, manifest: p.draft.manifest });
      }
      if (tail === "/versions/info") {
        return json({
          latest_published_version: p.published.at(-1)?.version ?? null,
          active_version: (p.draft.manifest.version as string | undefined) ?? null,
        });
      }
      if (tail === "/versions" && method === "POST") {
        const body = JSON.parse(init!.body as string) as { version?: string };
        entry.body = body;
        if (p.publishError) {
          return problem(p.publishError.status, p.publishError.code, "Refused by the stand-in");
        }
        if (body.version !== undefined && body.version !== p.draft.manifest.version) {
          p.draft.manifest = { ...p.draft.manifest, version: body.version };
          p.draft.lock += 1;
        }
        const version = p.draft.manifest.version as string;
        p.published.push({ version, files: { ...p.draft.files } });
        return json({ version, integrity: "sha256-x" }, 201);
      }
    }

    return problem(404, "not_found", `not stubbed: ${method} ${path}`);
  };

  return {
    seen,
    install(): void {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
        respond(new URL(String(input)), init)) as unknown as typeof fetch;
    },
  };
}

function skill(overrides: Partial<FakePackage> = {}): FakePackage {
  return {
    id: "@acme/pdf",
    type: "skill",
    homeSpaceId: "spc_home",
    writable: true,
    readSpaceIds: ["spc_home"],
    draft: {
      lock: 3,
      manifest: { name: "@acme/pdf", type: "skill", version: "1.0.0" },
      files: { "SKILL.md": "---\nname: pdf\ndescription: PDFs.\n---\nDraft.\n", "ref/a.md": "a" },
    },
    published: [{ version: "1.0.0", files: { "SKILL.md": "---\nname: pdf\n---\nPublished.\n" } }],
    ...overrides,
  };
}

const configHome = useTempConfigHome("appstrate-cli-packages-cfg-");
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalDataHome = process.env.XDG_DATA_HOME;
let keyring: FakeKeyringInstall;
let root: string;

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  root = await mkdtemp(join(tmpdir(), "appstrate-cli-packages-cmd-"));
  process.env.HOME = join(root, "home");
  process.env.XDG_DATA_HOME = join(root, "data");
  await seedLoggedInProfile("default", { orgId: "org_1", spaceId: "spc_1" });
});

afterEach(async () => {
  keyring.restore();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  await configHome.teardown();
  await rm(root, { recursive: true, force: true });
});

const text = (path: string) => readFile(path, "utf-8");

async function pulled(
  pkg: FakePackage,
  dir: string,
): Promise<ReturnType<typeof createPackageServer>> {
  const server = createPackageServer([pkg]);
  server.install();
  await packagesPullCommand({ package: pkg.id, dir }, createMemoryIO().io);
  return server;
}

describe("packages pull", () => {
  it("writes the draft, drops RECORD, and records the lock read before the archive", async () => {
    const pkg = skill();
    pkg.draft.files.RECORD = "signature";
    const server = createPackageServer([pkg]);
    server.install();
    const dir = join(root, "pdf");
    const { io, stdout } = createMemoryIO();

    await packagesPullCommand({ package: "pdf", dir }, io);

    expect((await readdir(dir)).sort()).toEqual(["SKILL.md", "manifest.json", "ref"]);
    expect(await text(join(dir, "SKILL.md"))).toContain("Draft.");
    expect(await readLock("default", dir, "@acme/pdf")).toBe(3);
    const detail = server.seen.findIndex(
      (s) => s.path === "/api/packages/skills/@acme/pdf?version=draft",
    );
    const archive = server.seen.findIndex(
      (s) => s.path === "/api/packages/@acme/pdf/draft/download",
    );
    expect(detail).toBeGreaterThan(-1);
    expect(archive).toBeGreaterThan(detail);
    expect(server.seen[archive]!.spaceId).toBe("spc_home");
    expect(stdout()).toContain("Pulled @acme/pdf (skill, draft, 3 files)");
  });

  it("defaults to the work dir, under the type's route segment", async () => {
    createPackageServer([skill()]).install();
    await packagesPullCommand({ package: "@acme/pdf" }, createMemoryIO().io);
    const dir = join(root, "home", "Appstrate Packages", "acme", "packages", "skills", "pdf");
    expect(await text(join(dir, "SKILL.md"))).toContain("Draft.");
  });

  it("reads a read-only package's published version from a space that reads it", async () => {
    const server = createPackageServer([
      skill({ writable: false, homeSpaceId: null, readSpaceIds: ["spc_2"] }),
    ]);
    server.install();
    const dir = join(root, "pdf");
    const { io, stdout, stderr } = createMemoryIO();

    await packagesPullCommand({ package: "@acme/pdf", dir }, io);

    expect(await text(join(dir, "SKILL.md"))).toContain("Published.");
    expect((await readdir(dir)).sort()).toEqual(["SKILL.md", "manifest.json"]);
    const download = server.seen.find((s) => s.path.endsWith("/latest/download"));
    expect(download?.spaceId).toBe("spc_2");
    expect(server.seen.some((s) => s.path.includes("draft"))).toBe(false);
    expect(await readLock("default", dir, "@acme/pdf")).toBeUndefined();
    expect(stdout()).toContain("published 1.0.0");
    expect(stderr()).toContain("Read-only");
  });

  it("refuses a non-empty folder without --force", async () => {
    createPackageServer([skill()]).install();
    const dir = join(root, "pdf");
    await mkdir(dir);
    await writeFile(join(dir, "mine.md"), "keep");
    const { io, stderr } = createMemoryIO();

    await expect(packagesPullCommand({ package: "@acme/pdf", dir }, io)).rejects.toBeInstanceOf(
      ExitError,
    );
    expect(stderr()).toContain("--force");
    expect(await text(join(dir, "mine.md"))).toBe("keep");
  });

  it("with --force, mirrors the package: extra files go, ignored entries stay", async () => {
    createPackageServer([skill()]).install();
    const dir = join(root, "pdf");
    await mkdir(join(dir, "old"), { recursive: true });
    await writeFile(join(dir, "old", "extra.md"), "stale");
    await writeFile(join(dir, ".env"), "SECRET=1");
    const { io, stderr } = createMemoryIO();

    await packagesPullCommand({ package: "@acme/pdf", dir, force: true }, io);

    expect((await readdir(dir)).sort()).toEqual([".env", "SKILL.md", "manifest.json", "ref"]);
    expect(await text(join(dir, ".env"))).toBe("SECRET=1");
    expect(stderr()).toContain("Removed 1 file(s) the package does not have: old/extra.md");
  });
});

describe("packages status", () => {
  it("is clean right after a pull, and lists what the folder changed", async () => {
    const dir = join(root, "pdf");
    await pulled(skill(), dir);

    const clean = createMemoryIO();
    await packagesStatusCommand({ dir }, clean.io);
    expect(clean.stdout()).toContain("clean: the folder matches the draft");

    await writeFile(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\nEdited.\n");
    await writeFile(join(dir, ".env"), "SECRET=1");
    const changed = createMemoryIO();
    await packagesStatusCommand({ dir, diff: true }, changed.io);
    expect(changed.stdout()).toContain("  M SKILL.md");
    expect(changed.stdout()).toContain("+ Edited.");
    expect(changed.stdout()).not.toContain(".env");
  });

  it("shows the lock drift when the draft moved elsewhere", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    await pulled(pkg, dir);
    pkg.draft.lock = 5;
    const { io, stdout } = createMemoryIO();

    await packagesStatusCommand({ dir }, io);

    expect(stdout()).toContain("lock 3 → 5");
  });
});

describe("packages push", () => {
  it("sends ONE PUT under the recorded lock and rewrites the manifest the server stored", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    const server = await pulled(pkg, dir);
    await writeFile(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\nEdited.\n");
    await writeFile(join(dir, "new.bin"), new Uint8Array([0xff, 0x00]));
    await rm(join(dir, "ref"), { recursive: true });
    const manifest = JSON.parse(await text(join(dir, "manifest.json")));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ ...manifest, description: "More" }),
    );
    const { io, stdout } = createMemoryIO();

    await packagesPushCommand({ dir }, io);

    const puts = server.seen.filter((s) => s.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.spaceId).toBe("spc_home");
    expect(puts[0]!.body).toEqual({
      lock_version: 3,
      manifest: { ...manifest, description: "More" },
      operations: [
        {
          op: "write",
          path: "SKILL.md",
          text: "---\nname: pdf\ndescription: PDFs.\n---\nEdited.\n",
        },
        { op: "write", path: "new.bin", bytes_base64: "/wA=" },
        { op: "delete", path: "ref/a.md" },
      ],
    });
    expect(JSON.parse(await text(join(dir, "manifest.json")))).toEqual(pkg.draft.manifest);
    expect(pkg.draft.manifest.schema_version).toBe("1.0");
    expect(await readLock("default", dir, "@acme/pdf")).toBe(4);
    expect(stdout()).toContain("Pushed 3 file operation(s) and the manifest");

    const status = createMemoryIO();
    await packagesStatusCommand({ dir }, status.io);
    expect(status.stdout()).toContain("clean");
  });

  it("says the draft moved elsewhere on 409, naming both locks", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    await pulled(pkg, dir);
    pkg.draft.lock = 4;
    await writeFile(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\nMine.\n");
    const { io, stderr } = createMemoryIO();

    await expect(packagesPushCommand({ dir }, io)).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain("was edited elsewhere since this folder last saw it (lock 3 → 4)");
    expect(stderr()).toContain("push --force");
    expect(pkg.draft.files["SKILL.md"]).toContain("Draft.");
  });

  it("refuses a folder that never pulled the draft, pointing at push --force only", async () => {
    const server = createPackageServer([skill()]);
    server.install();
    const dir = join(root, "pdf");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\nMine.\n");
    const { io, stderr } = createMemoryIO();

    await expect(packagesPushCommand({ dir }, io)).rejects.toBeInstanceOf(ExitError);

    // `pull --force` would overwrite the very edits this push is about.
    expect(stderr()).toContain(`appstrate packages push ${dir} --force`);
    expect(stderr()).not.toContain("pull --force");
    expect(stderr()).not.toContain("packages pull");
    expect(server.seen.some((s) => s.method === "PUT")).toBe(false);
  });

  it("with --force, replaces the draft under the lock it just read", async () => {
    const pkg = skill();
    const server = createPackageServer([pkg]);
    server.install();
    const dir = join(root, "pdf");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\nMine.\n");

    await packagesPushCommand({ dir, force: true }, createMemoryIO().io);

    const put = server.seen.find((s) => s.method === "PUT");
    // No manifest.json in the folder: the draft's manifest is neither compared nor sent.
    expect(put?.body).toEqual({
      lock_version: 3,
      operations: [
        { op: "write", path: "SKILL.md", text: "---\nname: pdf\ndescription: PDFs.\n---\nMine.\n" },
        { op: "delete", path: "ref/a.md" },
      ],
    });
    expect(await readLock("default", dir, "@acme/pdf")).toBe(4);
  });

  it("creates a missing package through the import route only with --create", async () => {
    const server = createPackageServer([]);
    server.install();
    const dir = join(root, "fresh");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "---\nname: fresh\ndescription: New.\n---\nBody.\n");
    await writeFile(join(dir, ".env"), "SECRET=1");

    const refused = createMemoryIO();
    await expect(packagesPushCommand({ dir }, refused.io)).rejects.toBeInstanceOf(ExitError);
    expect(refused.stderr()).toContain("--create");

    const { io, stdout } = createMemoryIO();
    await packagesPushCommand({ dir, create: true, space: "spc_mine" }, io);

    const imported = server.seen.find((s) => s.path === "/api/packages/import");
    expect(imported?.spaceId).toBe("spc_mine");
    expect(imported?.body).toEqual({ fileName: "fresh.zip" });
    expect(JSON.parse(await text(join(dir, "manifest.json")))).toEqual({
      name: "@acme/fresh",
      type: "skill",
      version: "1.0.0",
    });
    expect(await readLock("default", dir, "@acme/fresh")).toBe(1);
    expect(stdout()).toContain(
      "Created @acme/fresh in space spc_mine and published its first version 1.0.0",
    );
  });
});

describe("packages publish", () => {
  it("bumps a draft still at the latest version and syncs the folders current with it", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    const server = await pulled(pkg, dir);
    const { io, stdout } = createMemoryIO();

    await packagesPublishCommand({ package: dir, bump: "minor" }, io);

    expect(
      server.seen.find((s) => s.path.endsWith("/versions") && s.method === "POST")?.body,
    ).toEqual({ version: "1.1.0" });
    expect(stdout()).toContain("Published @acme/pdf@1.1.0");
    expect(JSON.parse(await text(join(dir, "manifest.json"))).version).toBe("1.1.0");
    expect(await readLock("default", dir, "@acme/pdf")).toBe(4);

    const status = createMemoryIO();
    await packagesStatusCommand({ dir }, status.io);
    expect(status.stdout()).toContain("clean");
    expect(status.stdout()).not.toContain("edited elsewhere");
  });

  it("carries only the version into a synced folder, keeping its own manifest edits", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    await pulled(pkg, dir);
    const mine = { ...JSON.parse(await text(join(dir, "manifest.json"))), description: "Mine" };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(mine));

    await packagesPublishCommand({ package: "@acme/pdf" }, createMemoryIO().io);

    expect(JSON.parse(await text(join(dir, "manifest.json")))).toEqual({
      ...mine,
      version: "1.0.1",
    });
    expect(await readLock("default", dir, "@acme/pdf")).toBe(4);
  });

  it("cuts a draft ahead of the latest version as is", async () => {
    const pkg = skill();
    pkg.draft.manifest.version = "2.0.0";
    const server = createPackageServer([pkg]);
    server.install();
    const { io, stdout } = createMemoryIO();

    await packagesPublishCommand({ package: "@acme/pdf" }, io);

    expect(
      server.seen.find((s) => s.path.endsWith("/versions") && s.method === "POST")?.body,
    ).toEqual({});
    expect(stdout()).toContain("Published @acme/pdf@2.0.0");
    expect(pkg.draft.lock).toBe(3);
  });

  it("refuses a draft behind the latest version, naming both", async () => {
    const pkg = skill();
    pkg.draft.manifest.version = "0.9.0";
    const server = createPackageServer([pkg]);
    server.install();
    const { io, stderr } = createMemoryIO();

    await expect(packagesPublishCommand({ package: "@acme/pdf" }, io)).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(stderr()).toContain("0.9.0");
    expect(stderr()).toContain("1.0.0");
    expect(server.seen.some((s) => s.path.endsWith("/versions") && s.method === "POST")).toBe(
      false,
    );
  });

  it("refuses a draft that has not moved since the latest version, like the dashboard", async () => {
    const pkg = skill();
    pkg.draft.unpublished = false;
    const server = createPackageServer([pkg]);
    server.install();
    const { io, stderr } = createMemoryIO();

    await expect(packagesPublishCommand({ package: "@acme/pdf" }, io)).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(stderr()).toContain("there is nothing to publish");
    expect(server.seen.some((s) => s.path.endsWith("/versions") && s.method === "POST")).toBe(
      false,
    );
  });

  it("refuses a draft with no valid version", async () => {
    const pkg = skill();
    pkg.draft.manifest.version = "not-a-version";
    createPackageServer([pkg]).install();
    const { io, stderr } = createMemoryIO();

    await expect(packagesPublishCommand({ package: "@acme/pdf" }, io)).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(stderr()).toContain("no valid `version`");
  });

  for (const [code, message] of [
    ["no_changes", "Nothing changed in the draft of @acme/pdf"],
    ["agent_in_use", "has runs in progress; retry when they finish"],
  ] as const) {
    it(`explains ${code}`, async () => {
      createPackageServer([skill({ publishError: { status: 409, code } })]).install();
      const { io, stderr } = createMemoryIO();

      await expect(packagesPublishCommand({ package: "@acme/pdf" }, io)).rejects.toBeInstanceOf(
        ExitError,
      );

      expect(stderr()).toContain(message);
    });
  }
});
