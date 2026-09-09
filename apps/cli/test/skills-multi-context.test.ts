// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillsSyncCommand } from "../src/commands/skills.ts";
import { getDataDir, getProfile, updateProfile } from "../src/lib/config.ts";
import { getStatePath } from "../src/lib/skills-sync/state.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { ExitError } from "./helpers/process-exit.ts";
import { createSkillServer, skillMd, type SkillFixture } from "./helpers/skills-server.ts";

const configHome = useTempConfigHome("appstrate-multi-context-config-");
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalDataHome = process.env.XDG_DATA_HOME;
let keyring: FakeKeyringInstall;
let directory: string;

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  directory = await mkdtemp(join(tmpdir(), "appstrate-multi-context-"));
  process.env.HOME = join(directory, "home");
  process.env.XDG_DATA_HOME = join(directory, "data");
  await seedLoggedInProfile("default", { orgId: "org_1", spaceId: "spc_active" });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  keyring.restore();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  await configHome.teardown();
  await rm(directory, { recursive: true, force: true });
});

const pluginRoot = (): string => join(getDataDir(), "claude-plugin");
const SPACES = [
  { id: "spc_active", name: "Active" },
  { id: "spc_library", name: "Library" },
];

/**
 * `memberships` is the space → package attribution (`space_packages`), and
 * `reachable` is what `GET /api/spaces` answers for this principal — the two
 * halves the real API keeps apart. Default: every space named in `memberships`.
 */
function installSpaces(
  fixtures: SkillFixture[],
  memberships: Record<string, string[]>,
  options: {
    failingSpace?: string;
    duplicateNames?: boolean;
    seen?: string[];
    reachable?: string[];
  } = {},
) {
  const server = createSkillServer(fixtures);
  server.install();
  const serve = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const spaceId = new Headers(init?.headers).get("X-Space-Id") ?? "";
    if (url.pathname === "/api/spaces") {
      const reachable = options.reachable ?? Object.keys(memberships);
      return Response.json({
        data: SPACES.filter((space) => reachable.includes(space.id)).map((space) => ({
          ...space,
          name: options.duplicateNames ? "Duplicate" : space.name,
        })),
      });
    }
    if (url.pathname === "/api/packages/skills") {
      if (spaceId === options.failingSpace)
        return Response.json({ message: "Unavailable" }, { status: 503 });
      return Response.json({ data: (memberships[spaceId] ?? []).map((id) => ({ id })) });
    }
    const packageId = fixtures.find((fixture) => url.pathname.includes(fixture.id));
    if (packageId) {
      // Return an authorization failure on the wrong origin, like the real API.
      if (!memberships[spaceId]?.includes(packageId.id)) {
        return Response.json({ message: "Wrong space" }, { status: 403 });
      }
      options.seen?.push(`${spaceId}:${url.pathname}`);
    }
    return serve(input, init);
  }) as typeof fetch;
  return server;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [path, content] of Object.entries(await snapshot(join(root, entry.name)))) {
        result[`${entry.name}/${path}`] = content;
      }
    } else {
      result[entry.name] = await readFile(join(root, entry.name), "utf8");
    }
  }
  return result;
}

describe("multi-space skill distribution regressions", () => {
  it("reads draft metadata, file index and non-inline contents in their source space", async () => {
    const seen: string[] = [];
    const server = installSpaces(
      [
        {
          id: "@acme/library",
          skillMd: skillMd("library"),
          draft: { fetchedFiles: { "references/detail.md": "Library-only draft reference" } },
        },
      ],
      { spc_library: ["@acme/library"] },
      { seen },
    );

    await skillsSyncCommand({ space: ["spc_library"], source: "draft" }, createMemoryIO().io);

    expect(server.indexReads()).toBe(1);
    expect(server.contentReads()).toBe(1);
    expect(seen).toContain("spc_library:/api/packages/skills/@acme/library");
    expect(seen).toContain("spc_library:/api/packages/@acme/library/files");
    expect(seen).toContain("spc_library:/api/packages/@acme/library/files/content");
    expect(await readFile(join(pluginRoot(), "skills/library/references/detail.md"), "utf8")).toBe(
      "Library-only draft reference",
    );
    const mcp = JSON.parse(await readFile(join(pluginRoot(), ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.appstrate.headers["X-Space-Id"]).toBe("spc_active");
    expect((await getProfile("default"))?.spaceId).toBe("spc_active");
  });

  it("preserves the full installation and ledger if any selected space listing fails", async () => {
    const fixtures = [{ id: "@acme/retained", skillMd: skillMd("retained") }];
    installSpaces(fixtures, { spc_active: ["@acme/retained"] });
    await skillsSyncCommand({}, createMemoryIO().io);
    const before = await snapshot(pluginRoot());
    const ledger = await readFile(getStatePath(), "utf8");
    installSpaces(fixtures, { spc_active: [], spc_library: [] }, { failingSpace: "spc_library" });
    const { io, stdout } = createMemoryIO();

    await expect(
      skillsSyncCommand({ space: ["spc_active", "spc_library"], printPath: true }, io),
    ).rejects.toBeInstanceOf(ExitError);

    expect(stdout()).toBe("");
    expect(await snapshot(pluginRoot())).toEqual(before);
    expect(await readFile(getStatePath(), "utf8")).toBe(ledger);
  });

  it("removes only exclusive skills when a configured space is removed", async () => {
    const server = installSpaces(
      [
        { id: "@acme/shared", skillMd: skillMd("shared") },
        { id: "@acme/exclusive", skillMd: skillMd("exclusive") },
      ],
      { spc_active: ["@acme/shared"], spc_library: ["@acme/shared", "@acme/exclusive"] },
    );
    await updateProfile("default", { syncSpaces: ["spc_active", "spc_library"] });
    await skillsSyncCommand({}, createMemoryIO().io);
    expect(server.downloads()).toBe(2);

    await updateProfile("default", { syncSpaces: ["spc_active"] });
    await skillsSyncCommand({}, createMemoryIO().io);

    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual(["shared"]);
    expect(server.downloads()).toBe(2);
    expect((await getProfile("default"))?.syncSpaces).toEqual(["spc_active"]);
  });

  it("rejects ambiguous names without altering the installed plugin or ledger", async () => {
    const fixtures = [{ id: "@acme/retained", skillMd: skillMd("retained") }];
    installSpaces(
      fixtures,
      { spc_active: ["@acme/retained"], spc_library: [] },
      { duplicateNames: true },
    );
    await skillsSyncCommand({}, createMemoryIO().io);
    const before = await snapshot(pluginRoot());
    const ledger = await readFile(getStatePath(), "utf8");
    const { io, stderr, stdout } = createMemoryIO();

    await expect(
      skillsSyncCommand({ space: ["Duplicate"], printPath: true }, io),
    ).rejects.toBeInstanceOf(ExitError);

    expect(stderr()).toMatch(/ambiguous/i);
    expect(stdout()).toBe("");
    expect(await snapshot(pluginRoot())).toEqual(before);
    expect(await readFile(getStatePath(), "utf8")).toBe(ledger);
  });
});

describe("multi-space skill distribution — access decides the sources", () => {
  const TWO_SPACES = [
    { id: "@acme/active-only", skillMd: skillMd("active-only") },
    { id: "@acme/library-only", skillMd: skillMd("library-only") },
    { id: "@acme/shared", skillMd: skillMd("shared") },
  ];
  const BOTH = {
    spc_active: ["@acme/active-only", "@acme/shared"],
    spc_library: ["@acme/library-only", "@acme/shared"],
  };

  it("installs the union of every reachable space, downloading a shared package once", async () => {
    const server = installSpaces(TWO_SPACES, BOTH);

    await skillsSyncCommand({}, createMemoryIO().io);

    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual([
      "active-only",
      "library-only",
      "shared",
    ]);
    // `@acme/shared` is one org package attributed to both spaces.
    expect(server.downloads()).toBe(3);
  });

  it("picks up a newly reachable space, and drops one that is taken away", async () => {
    installSpaces(TWO_SPACES, BOTH, { reachable: ["spc_active"] });
    await skillsSyncCommand({}, createMemoryIO().io);
    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual(["active-only", "shared"]);

    installSpaces(TWO_SPACES, BOTH);
    await skillsSyncCommand({}, createMemoryIO().io);
    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual([
      "active-only",
      "library-only",
      "shared",
    ]);

    // Access revoked: the exclusive skill goes, the shared one stays because
    // the other space still supplies it.
    installSpaces(TWO_SPACES, BOTH, { reachable: ["spc_active"] });
    const { io, stderr } = createMemoryIO();
    await skillsSyncCommand({}, io);
    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual(["active-only", "shared"]);
    expect(stderr()).not.toMatch(/not accessible/);
  });

  it("warns when the pinned space died, and still syncs the spaces that live", async () => {
    // The pin no longer supplies any skill, so nothing else in the run would
    // notice it broke — but it is still what `.mcp.json` sends.
    installSpaces(TWO_SPACES, BOTH, { reachable: ["spc_library"] });
    const { io, stderr } = createMemoryIO();

    await skillsSyncCommand({}, io);

    expect(stderr()).toContain('Pinned space "spc_active" is not accessible');
    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual([
      "library-only",
      "shared",
    ]);
    const mcp = JSON.parse(await readFile(join(pluginRoot(), ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.appstrate.headers["X-Space-Id"]).toBe("spc_active");
  });

  it("narrows to syncSpaces, and skips a configured space that access no longer covers", async () => {
    installSpaces(TWO_SPACES, BOTH);
    await updateProfile("default", { syncSpaces: ["spc_library"] });
    await skillsSyncCommand({}, createMemoryIO().io);
    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual([
      "library-only",
      "shared",
    ]);

    installSpaces(TWO_SPACES, BOTH, { reachable: ["spc_active"] });
    await updateProfile("default", { syncSpaces: ["spc_active", "spc_library"] });
    const { io, stderr } = createMemoryIO();
    await skillsSyncCommand({}, io);

    // A stored id the grant no longer covers is a note, not a run failure: the
    // spaces that ARE reachable still sync.
    expect(stderr()).toContain('Configured sync space "spc_library" is not accessible');
    expect((await readdir(join(pluginRoot(), "skills"))).sort()).toEqual(["active-only", "shared"]);
  });
});
