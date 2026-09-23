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
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeIntegrity } from "@appstrate/core/integrity";
import { unzipArtifact, zipArtifact } from "@appstrate/core/zip";
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
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
  /** Problem the draft PUT answers with instead of writing. */
  putError?: { status: number; code: string };
  /**
   * Someone else writes the draft between the PUT's write and its read-back:
   * the response then carries a lock two steps ahead of the one it was sent.
   */
  concurrentWriteAfterPut?: boolean;
  /**
   * Someone else pushes while the version POST runs: the lock moves by one and
   * the server, seeing the draft written in between, leaves its version alone.
   */
  concurrentPushOnPublish?: boolean;
  /** A push lands after the CLI read the draft and before it publishes. */
  pushBetweenReadAndPublish?: boolean;
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

/**
 * `homeRoute: false` is an instance older than `GET …/home`: its `/api/*`
 * fallback answers. `spaceGone` is the space context refusing the pinned space.
 */
function createPackageServer(
  packages: FakePackage[],
  { homeRoute = true, spaceGone = false } = {},
) {
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
      if (!homeRoute) return problem(404, "not_found", `API endpoint not found: GET ${path}`);
      if (spaceGone) return problem(404, "not_found", "Space 'spc_gone' not found");
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
      if (!p || spaceId !== p.homeSpaceId) return problem(404, "not_found", "Not here");
      if (!p.writable) return problem(403, "draft_not_writable", "Not yours");
      return new Response(new Uint8Array(zipOf(draftTree(p))), {
        headers: { "Content-Type": "application/zip", ETag: `"d${p.draft.lock}"` },
      });
    }

    const download = path.match(/^\/api\/packages\/(@[^/]+)\/([^/]+)\/([^/]+)\/download$/);
    if (download) {
      const p = byId(download[1]!, download[2]!);
      const reads = p && (spaceId === p.homeSpaceId || p.readSpaceIds.includes(spaceId ?? ""));
      if (!p || !reads) return problem(404, "not_found", "Not here");
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
      if (!p || PACKAGE_TYPE_ROUTE_SEGMENT[p.type] !== typed[1] || spaceId !== p.homeSpaceId) {
        return problem(404, "not_found", "Not here");
      }
      const tail = typed[4];
      if (!tail && method === "GET") {
        const read = json({
          id: p.id,
          lock_version: p.draft.lock,
          manifest: p.draft.manifest,
          has_unarchived_changes: p.draft.unpublished ?? true,
        });
        if (p.pushBetweenReadAndPublish) {
          p.pushBetweenReadAndPublish = false;
          p.draft.lock += 1;
        }
        return read;
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
        if (p.putError) {
          return problem(p.putError.status, p.putError.code, "Refused by the stand-in");
        }
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
        if (p.concurrentWriteAfterPut) {
          p.concurrentWriteAfterPut = false;
          p.draft.lock += 1;
        }
        return json({
          id: p.id,
          lock_version: p.draft.lock,
          manifest: p.draft.manifest,
          has_unarchived_changes: true,
        });
      }
      if (tail === "/versions/info") {
        return json({
          latest_published_version: p.published.at(-1)?.version ?? null,
          active_version: (p.draft.manifest.version as string | undefined) ?? null,
        });
      }
      if (tail === "/versions" && method === "POST") {
        const body = JSON.parse(init!.body as string) as {
          version?: string;
          lock_version?: number;
        };
        entry.body = body;
        if (body.lock_version !== undefined && body.lock_version !== p.draft.lock) {
          return problem(409, "conflict", "The draft changed since you read it.");
        }
        if (p.publishError) {
          return problem(p.publishError.status, p.publishError.code, "Refused by the stand-in");
        }
        let version = p.draft.manifest.version as string;
        if (p.concurrentPushOnPublish) {
          p.draft.lock += 1;
          version = body.version ?? version;
        } else if (body.version !== undefined && body.version !== version) {
          p.draft.manifest = { ...p.draft.manifest, version: body.version };
          p.draft.lock += 1;
          version = body.version;
        }
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

/** The default working copy of a skill: `<workDir>/<org slug>/packages/skills/<@scope>/<name>`. */
const workCopy = (scope: string, name: string) =>
  join(root, "home", "Appstrate Packages", "acme", "packages", "skills", scope, name);

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

  it("defaults to the work dir, under the type's route segment and the package's scope", async () => {
    createPackageServer([skill()]).install();
    await packagesPullCommand({ package: "@acme/pdf" }, createMemoryIO().io);
    const dir = workCopy("@acme", "pdf");
    expect(await text(join(dir, "SKILL.md"))).toContain("Draft.");

    // Found again by its scoped id, or by a bare name under the org's slug.
    for (const ref of ["@acme/pdf", "pdf"]) {
      const { io, stdout } = createMemoryIO();
      await packagesStatusCommand({ dir: ref }, io);
      expect(stdout()).toContain(`← ${dir}`);
      expect(stdout()).toContain("clean");
    }
  });

  it("never writes ignored entries a definition carries, and says which", async () => {
    const pkg = skill();
    pkg.draft.files[".git/config"] = "[core]\n\tfsmonitor = evil\n";
    pkg.draft.files[".vscode/tasks.json"] = "{}";
    createPackageServer([pkg]).install();
    const dir = join(root, "pdf");
    const { io, stderr } = createMemoryIO();

    await packagesPullCommand({ package: "@acme/pdf", dir }, io);

    expect((await readdir(dir)).sort()).toEqual(["SKILL.md", "manifest.json", "ref"]);
    expect(stderr()).toContain(
      "Not written (ignored by the authoring loop): .git/config, .vscode/tasks.json",
    );
  });

  it("refuses, before writing anything, two paths that are one file on an insensitive disk", async () => {
    const pkg = skill();
    pkg.draft.files["A.md"] = "upper";
    pkg.draft.files["a.md"] = "lower";
    createPackageServer([pkg]).install();
    const dir = join(root, "pdf");
    const { io, stderr } = createMemoryIO();

    await expect(packagesPullCommand({ package: "@acme/pdf", dir }, io)).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(stderr()).toContain('"A.md" and "a.md"');
    expect(await readdir(dir).catch(() => null)).toBeNull();
  });

  it("matches a draft path in another Unicode normalization to the folder's file", async () => {
    const pkg = skill();
    pkg.draft.files["Cafe\u0301.md"] = "decomposed";
    createPackageServer([pkg]).install();
    const dir = join(root, "pdf");
    await packagesPullCommand({ package: "@acme/pdf", dir }, createMemoryIO().io);

    const { io, stdout } = createMemoryIO();
    await packagesStatusCommand({ dir }, io);

    expect(stdout()).toContain("clean");
  });

  it("with --force, keeps a folder file that is the draft's file in another normalization", async () => {
    const pkg = skill();
    pkg.draft.files["Cafe\u0301.md"] = "new";
    createPackageServer([pkg]).install();
    const dir = join(root, "pdf");
    await mkdir(dir);
    await writeFile(join(dir, "Caf\u00e9.md"), "old");
    const { io, stderr } = createMemoryIO();

    await packagesPullCommand({ package: "@acme/pdf", dir, force: true }, io);

    expect(stderr()).not.toContain("Removed");
    expect(await text(join(dir, "Cafe\u0301.md"))).toBe("new");
  });

  describe("<package>@<spec>", () => {
    /** A writable skill published twice, so an exact version is told apart from `latest`. */
    const twoVersions = () =>
      skill({
        published: [
          { version: "1.0.0", files: { "SKILL.md": "---\nname: pdf\n---\nOne.\n" } },
          { version: "1.1.0", files: { "SKILL.md": "---\nname: pdf\n---\nOne-one.\n" } },
        ],
      });

    it("pulls that published version even for a writer, and records no lock", async () => {
      // Delete-to-fail (#1516): the spec used to ride on `--version`, which
      // the root `-V/--version` swallowed — the pull never happened.
      const server = createPackageServer([twoVersions()]);
      server.install();
      const dir = join(root, "pdf");
      const { io, stdout, stderr } = createMemoryIO();

      await packagesPullCommand({ package: "@acme/pdf@1.0.0", dir }, io);

      expect(await text(join(dir, "SKILL.md"))).toContain("One.");
      expect(server.seen.some((s) => s.path.endsWith("/1.0.0/download"))).toBe(true);
      expect(server.seen.some((s) => s.path.includes("draft"))).toBe(false);
      expect(await readLock("default", dir, "@acme/pdf")).toBeUndefined();
      expect(stdout()).toContain("Pulled @acme/pdf (skill, published 1.0.0, 2 files)");
      expect(stderr()).toContain("This is a published version, not the draft");
    });

    it("takes a tag on a bare name, under the organization's slug", async () => {
      const server = createPackageServer([twoVersions()]);
      server.install();
      const dir = join(root, "pdf");
      const { io, stdout } = createMemoryIO();

      await packagesPullCommand({ package: "pdf@latest", dir }, io);

      expect(await text(join(dir, "SKILL.md"))).toContain("One-one.");
      expect(server.seen.some((s) => s.path.endsWith("/latest/download"))).toBe(true);
      expect(stdout()).toContain("published 1.1.0");
    });

    it("reads the draft for @draft, lock included", async () => {
      const server = createPackageServer([twoVersions()]);
      server.install();
      const dir = join(root, "pdf");

      await packagesPullCommand({ package: "@acme/pdf@draft", dir }, createMemoryIO().io);

      expect(await text(join(dir, "SKILL.md"))).toContain("Draft.");
      expect(server.seen.some((s) => s.path === "/api/packages/@acme/pdf/draft/download")).toBe(
        true,
      );
      expect(await readLock("default", dir, "@acme/pdf")).toBe(3);
    });

    it("refuses @draft to a reader instead of falling back to the published version", async () => {
      const server = createPackageServer([
        skill({ writable: false, homeSpaceId: null, readSpaceIds: ["spc_2"] }),
      ]);
      server.install();
      const dir = join(root, "pdf");
      const { io, stderr } = createMemoryIO();

      await expect(
        packagesPullCommand({ package: "@acme/pdf@draft", dir }, io),
      ).rejects.toBeInstanceOf(ExitError);

      expect(stderr()).toContain("The draft of @acme/pdf is the author's working copy.");
      expect(stderr()).toContain("appstrate packages pull @acme/pdf@latest");
      expect(server.seen.some((s) => s.path.endsWith("/download"))).toBe(false);
      await expect(readdir(dir)).rejects.toThrow();
    });

    it("says which version does not exist, once", async () => {
      createPackageServer([twoVersions()]).install();
      const dir = join(root, "pdf");
      const { io, stderr } = createMemoryIO();

      await expect(
        packagesPullCommand({ package: "@acme/pdf@9.9.9", dir }, io),
      ).rejects.toBeInstanceOf(ExitError);

      expect(stderr()).toContain("No such version");
      expect(stderr().split("No such version").length - 1).toBe(1);
    });

    it("refuses an empty spec before calling the instance", async () => {
      const server = createPackageServer([twoVersions()]);
      server.install();
      const { io, stderr } = createMemoryIO();

      await expect(
        packagesPullCommand({ package: "@acme/pdf@", dir: join(root, "pdf") }, io),
      ).rejects.toBeInstanceOf(ExitError);

      expect(stderr()).toContain('@acme/pdf@: nothing after "@"');
      expect(server.seen.some((s) => s.path.startsWith("/api/packages"))).toBe(false);
    });
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

describe("working copies found by name", () => {
  it("refuses a work-dir folder that holds another package", async () => {
    createPackageServer([skill()]).install();
    const dir = workCopy("@acme", "pdf");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ name: "@other/pdf", type: "skill", version: "1.0.0" }),
    );
    await writeFile(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\n");
    const { io, stderr } = createMemoryIO();

    await expect(packagesStatusCommand({ dir: "pdf" }, io)).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain("holds @other/pdf, not @acme/pdf");
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
    // #1517: the translation is the whole message — not the server's wording
    // appended after it ("…replace it.: The package was modified…").
    expect(stderr()).not.toContain("The package was modified since you loaded it");
    expect(stderr()).not.toContain(".:");
    expect(pkg.draft.files["SKILL.md"]).toContain("Draft.");
  });

  it("accepts an unchanged file over the write limit, and refuses to write one", async () => {
    const pkg = skill();
    pkg.draft.files["big.bin"] = new Uint8Array(2 * 1_048_576);
    const dir = join(root, "pdf");
    const server = await pulled(pkg, dir);

    const status = createMemoryIO();
    await packagesStatusCommand({ dir }, status.io);
    expect(status.stdout()).toContain("clean");

    await writeFile(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\nEdited.\n");
    await packagesPushCommand({ dir }, createMemoryIO().io);
    const puts = server.seen.filter((s) => s.method === "PUT");
    expect(puts).toHaveLength(1);
    expect((puts[0]!.body as { operations: unknown[] }).operations).toEqual([
      { op: "write", path: "SKILL.md", text: "---\nname: pdf\ndescription: PDFs.\n---\nEdited.\n" },
    ]);

    const edited = new Uint8Array(2 * 1_048_576);
    edited[0] = 1;
    await writeFile(join(dir, "big.bin"), edited);
    const { io, stderr } = createMemoryIO();
    await expect(packagesPushCommand({ dir }, io)).rejects.toBeInstanceOf(ExitError);
    expect(stderr()).toMatch(/big\.bin: 2097152 bytes, over the 1 MiB limit/);
    expect(server.seen.filter((s) => s.method === "PUT")).toHaveLength(1);
  });

  it("pushes node_modules: an MCP server bundle ships it", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    const server = await pulled(pkg, dir);
    await mkdir(join(dir, "server", "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "server", "node_modules", "dep", "index.js"), "module.exports = 1;");

    await packagesPushCommand({ dir }, createMemoryIO().io);

    const put = server.seen.find((s) => s.method === "PUT");
    expect((put?.body as { operations: unknown[] }).operations).toEqual([
      { op: "write", path: "server/node_modules/dep/index.js", text: "module.exports = 1;" },
    ]);
  });

  it("records the lock its own write produced, not a later one the read-back shows", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    await pulled(pkg, dir);
    const manifest = JSON.parse(await text(join(dir, "manifest.json")));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...manifest, description: "M" }));
    pkg.concurrentWriteAfterPut = true;
    const { io, stderr } = createMemoryIO();

    await packagesPushCommand({ dir }, io);

    expect(pkg.draft.lock).toBe(5);
    expect(await readLock("default", dir, "@acme/pdf")).toBe(4);
    expect(stderr()).toContain("moved again right after this push (lock 4 → 5)");
    // Not rewritten from the read-back: it may already hold the other author's write.
    expect(JSON.parse(await text(join(dir, "manifest.json")))).toEqual({
      ...manifest,
      description: "M",
    });

    await writeFile(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\nNext.\n");
    const next = createMemoryIO();
    await expect(packagesPushCommand({ dir }, next.io)).rejects.toBeInstanceOf(ExitError);
    expect(next.stderr()).toContain("edited elsewhere since this folder last saw it (lock 4 → 5)");
  });

  it("reports a 409 that is not a stale lock as the problem it names", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    await pulled(pkg, dir);
    pkg.putError = { status: 409, code: "path_conflict" };
    await writeFile(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\nMine.\n");
    const { io, stderr } = createMemoryIO();

    await expect(packagesPushCommand({ dir }, io)).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain(
      "Push of @acme/pdf refused: Refused by the stand-in (path_conflict)",
    );
    expect(stderr().split("Refused by the stand-in").length - 1).toBe(1);
    expect(stderr()).not.toContain("edited elsewhere");
  });

  it("refuses --space without --create", async () => {
    const dir = join(root, "pdf");
    await pulled(skill(), dir);
    const { io, stderr } = createMemoryIO();

    await expect(packagesPushCommand({ dir, space: "spc_x" }, io)).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(stderr()).toContain("--space only applies with --create");
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

  it("does not take an instance older than GET …/home for a missing package", async () => {
    const server = createPackageServer([], { homeRoute: false });
    server.install();
    const dir = join(root, "fresh");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "---\nname: fresh\ndescription: New.\n---\nBody.\n");
    const { io, stderr } = createMemoryIO();

    await expect(packagesPushCommand({ dir, create: true }, io)).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain("older than this CLI");
    expect(stderr()).not.toContain("API endpoint not found");
    expect(server.seen.some((s) => s.path === "/api/packages/import")).toBe(false);
  });

  it("reports a refused pinned space as such, not as an older instance", async () => {
    createPackageServer([], { spaceGone: true }).install();
    const dir = join(root, "fresh");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "---\nname: fresh\ndescription: New.\n---\nBody.\n");
    const { io, stderr } = createMemoryIO();

    await expect(packagesPushCommand({ dir, create: true }, io)).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain("Space 'spc_gone' not found");
    expect(stderr()).not.toContain("older than this CLI");
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
    expect(refused.stderr()).not.toContain("Not sent");

    const { io, stdout, stderr } = createMemoryIO();
    await packagesPushCommand({ dir, create: true, space: "spc_mine" }, io);

    expect(stderr()).toContain("Not sent (ignored by the authoring loop): .env");
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
    ).toEqual({ version: "1.1.0", lock_version: 3 });
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

  it("leaves every folder behind when a concurrent push moved the draft during the publish", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    await pulled(pkg, dir);
    pkg.concurrentPushOnPublish = true;
    const { io, stdout, stderr } = createMemoryIO();

    await packagesPublishCommand({ package: "@acme/pdf" }, io);

    expect(stdout()).toContain("Published @acme/pdf@1.0.1");
    expect(pkg.draft.lock).toBe(4);
    // The lock moved by one, but for an edit this folder never saw.
    expect(await readLock("default", dir, "@acme/pdf")).toBe(3);
    expect(JSON.parse(await text(join(dir, "manifest.json"))).version).toBe("1.0.0");
    expect(stderr()).not.toContain("Updated the version");
  });

  it("warns, without failing the publish, when a synced folder's manifest cannot be updated", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    await pulled(pkg, dir);
    await writeFile(join(dir, "manifest.json"), "{ not json");
    const seen = await readLock("default", dir, "@acme/pdf");
    const { io, stdout, stderr } = createMemoryIO();

    await packagesPublishCommand({ package: "@acme/pdf" }, io);

    // Not carried, so not advanced: its next push is refused, not a silent revert.
    expect(await readLock("default", dir, "@acme/pdf")).toBe(seen);

    expect(stdout()).toContain("Published @acme/pdf@1.0.1");
    // Lock records are keyed by real path: that is the folder the warning names.
    expect(stderr()).toContain(
      `warning: could not carry version 1.0.1 into ${await realpath(dir)}`,
    );
  });

  it("publishes nothing when a push lands between reading the draft and publishing it", async () => {
    const pkg = skill({ pushBetweenReadAndPublish: true });
    const server = createPackageServer([pkg]);
    server.install();
    const { io, stderr } = createMemoryIO();

    await expect(packagesPublishCommand({ package: "@acme/pdf" }, io)).rejects.toBeInstanceOf(
      ExitError,
    );

    expect(stderr()).toContain("changed while this command read it");
    expect(pkg.published).toHaveLength(1);
  });

  it("refuses to publish from a folder holding changes the draft does not have", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    const server = await pulled(pkg, dir);
    await writeFile(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDFs.\n---\nUnpushed.\n");
    const { io, stderr } = createMemoryIO();

    await expect(packagesPublishCommand({ package: dir }, io)).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain(`${dir} has changes the draft does not have: push them first`);
    expect(server.seen.some((s) => s.path.endsWith("/versions") && s.method === "POST")).toBe(
      false,
    );
  });

  it("refuses to publish from a folder whose draft moved since it read it", async () => {
    const pkg = skill();
    const dir = join(root, "pdf");
    await pulled(pkg, dir);
    pkg.draft.lock = 7;
    const { io, stderr } = createMemoryIO();

    await expect(packagesPublishCommand({ package: dir }, io)).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toContain("has changes the draft does not have");
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
    ).toEqual({ lock_version: 3 });
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
      expect(stderr()).not.toContain("Refused by the stand-in");
    });
  }
});
