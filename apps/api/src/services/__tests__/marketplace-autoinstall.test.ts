import { describe, test, expect, mock, beforeEach } from "bun:test";

// --- Mocks ---

const noop = () => {};
const warnCalls: unknown[][] = [];

mock.module("../../lib/logger.ts", () => ({
  logger: {
    debug: noop,
    info: noop,
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
    error: noop,
  },
}));

// --- Drizzle mock (queue-based) ---

let selectQueue: unknown[][] = [];
let insertedRows: Record<string, unknown>[] = [];
let updatedSets: Record<string, unknown>[] = [];

function chainable(result: unknown[]) {
  const obj = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    orderBy: () => obj,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return obj;
}

const dbOps = {
  select: () => {
    const result = selectQueue.shift() ?? [];
    return chainable(result);
  },
  insert: () => ({
    values: (vals: Record<string, unknown>) => {
      insertedRows.push(vals);
      return Promise.resolve();
    },
  }),
  update: () => ({
    set: (vals: Record<string, unknown>) => ({
      where: () => {
        updatedSets.push(vals);
        return Promise.resolve();
      },
    }),
  }),
  execute: () => Promise.resolve(),
};

mock.module("../../lib/db.ts", () => ({
  db: {
    ...dbOps,
    transaction: async (fn: (tx: typeof dbOps) => Promise<void>) => fn(dbOps),
  },
}));

mock.module("@appstrate/env", () => ({
  getEnv: () => ({ REGISTRY_URL: "http://test-registry" }),
}));

// --- Registry client mock ---

const registryPackages = new Map<string, Record<string, unknown>>();

mock.module("@appstrate/registry-client", () => ({
  RegistryClient: class {
    async getPackage(scope: string, name: string) {
      const key = `${scope}/${name}`;
      return registryPackages.get(key) ?? null;
    }
    async downloadArtifact() {
      return {
        data: new Uint8Array([1, 2, 3]),
        integrity: "sha256-fixed",
        verified: true,
      };
    }
  },
}));

// --- ZIP mock (FIFO queue) ---

let zipQueue: Record<string, unknown>[] = [];

mock.module("@appstrate/core/zip", () => ({
  parsePackageZip: () => {
    const parsed = zipQueue.shift();
    if (!parsed) throw new Error("zipQueue empty — test setup error");
    return parsed;
  },
  PackageZipError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  zipArtifact: () => new Uint8Array(),
  unzipArtifact: () => ({ files: {} }),
}));

mock.module("@appstrate/core/integrity", () => ({
  computeIntegrity: () => "sha256-fixed",
}));

mock.module("@appstrate/core/validation", () => ({
  extractSkillMeta: () => ({ name: "test", description: "test" }),
}));

// @appstrate/core/naming — NOT mocked (pure functions, use real impl)
// @appstrate/core/dependencies — NOT mocked (pure function, use real impl)

mock.module("@appstrate/db/storage", () => ({
  ensureBucket: async () => {},
  uploadFile: async () => {},
  downloadFile: async () => null,
  deleteFile: async () => {},
}));

mock.module("../builtin-library.ts", () => ({
  getBuiltInSkills: () => new Map(),
  getBuiltInExtensions: () => new Map(),
  isBuiltInSkill: () => false,
  isBuiltInExtension: () => false,
  resolveBuiltInSkill: () => undefined,
  resolveBuiltInExtension: () => undefined,
  BUILTIN_SCOPE: "appstrate",
}));

mock.module("../package-versions.ts", () => ({
  createVersionAndUpload: async () => {},
  getLatestVersionId: async () => null,
}));

// --- DB schema stubs ---

mock.module("@appstrate/db/schema", () => ({
  packages: {
    id: "id",
    orgId: "org_id",
    type: "type",
    source: "source",
    name: "name",
    manifest: "manifest",
    content: "content",
    autoInstalled: "auto_installed",
    createdBy: "created_by",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  packageDependencies: {
    packageId: "package_id",
    dependencyId: "dependency_id",
    orgId: "org_id",
    createdAt: "created_at",
  },
}));

// --- Service mocks ---

const postInstallCalls: unknown[] = [];

mock.module("../registry-provider.ts", () => ({
  getRegistryClient: () => null,
  isRegistryConfigured: () => true,
  getRegistryDiscovery: () => null,
}));

// Mock post-install-package.ts (extracted from library.ts to avoid poisoning
// the library.ts mock scope — see oven-sh/bun#12823).
mock.module("../post-install-package.ts", () => ({
  postInstallPackage: async (params: unknown) => {
    postInstallCalls.push(params);
  },
}));

// --- Import after mocks ---

const { installFromMarketplace } = await import("../marketplace.ts");

// --- Helpers ---
//
// Query flow for _installInternal(scope, name, ...):
//   1. client.getPackage()              — mock registry, no DB
//   2. client.downloadArtifact()        — mock, no DB
//   3. computeIntegrity()               — mock
//   4. parsePackageZip()                — mock (zipQueue)
//   5. findMissingDependencies():
//      - extractDependencies(manifest)  — pure function
//      - if deps.length > 0:  SELECT (check which deps already installed)
//      - if deps.length === 0: returns [] immediately, NO SELECT
//   6. for each missing dep: recursive _installInternal (own queries)
//   7. SELECT: check if package already installed (existing check)
//   8. INSERT or UPDATE depending on step 7

function makeRegistryPkg(scope: string, name: string, description?: string) {
  return {
    name,
    description: description ?? `${name} package`,
    versions: [{ id: 1, version: "1.0.0" }],
    distTags: [{ tag: "latest", versionId: 1 }],
  };
}

function makeZipResult(type: "skill" | "extension" | "flow", manifest: Record<string, unknown>) {
  return {
    manifest: { displayName: manifest.displayName ?? "Test Package", ...manifest },
    content: "content-placeholder",
    files: {},
    type,
  };
}

// --- Tests ---

beforeEach(() => {
  selectQueue = [];
  insertedRows = [];
  updatedSets = [];
  warnCalls.length = 0;
  postInstallCalls.length = 0;
  registryPackages.clear();
  zipQueue = [];
});

describe("installFromMarketplace — auto-install deps", () => {
  test("package sans deps → insert simple, autoInstalled=false, pas d'autoInstalledDeps", async () => {
    registryPackages.set("@acme/solo", makeRegistryPkg("@acme", "solo"));
    zipQueue.push(makeZipResult("skill", { displayName: "Solo Skill" }));

    // No registryDependencies → extractDependencies returns [] → no SELECT for deps
    // Only 1 SELECT: existing check → not installed
    selectQueue = [
      [], // existing check → not installed → INSERT
    ];

    const result = await installFromMarketplace(
      "acme",
      "solo",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    expect(result.packageId).toBe("@acme/solo");
    expect(result.type).toBe("skill");
    expect(result.version).toBe("1.0.0");
    expect(result.autoInstalledDeps).toBeUndefined();
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]!.autoInstalled).toBe(false);
  });

  test("package avec 1 dep manquante → auto-install de la dep", async () => {
    registryPackages.set("@acme/parent", makeRegistryPkg("@acme", "parent"));
    registryPackages.set("@acme/helper", makeRegistryPkg("@acme", "helper"));

    zipQueue.push(
      makeZipResult("skill", {
        displayName: "Parent",
        registryDependencies: { skills: { "@acme/helper": "*" } },
      }),
    );
    zipQueue.push(makeZipResult("skill", { displayName: "Helper" }));

    // Parent: findMissingDeps SELECT → helper missing
    // Helper: no deps → no SELECT; existing check → not installed → INSERT
    // Parent: existing check → not installed → INSERT
    selectQueue = [
      [], // findMissingDeps for parent: helper not in DB → missing
      [], // existing check for helper → INSERT
      [], // existing check for parent → INSERT
    ];

    const result = await installFromMarketplace(
      "acme",
      "parent",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]!.id).toBe("@acme/helper");
    expect(insertedRows[0]!.autoInstalled).toBe(true);
    expect(insertedRows[1]!.id).toBe("@acme/parent");
    expect(insertedRows[1]!.autoInstalled).toBe(false);

    expect(result.autoInstalledDeps).toHaveLength(1);
    expect(result.autoInstalledDeps![0]!.packageId).toBe("@acme/helper");
  });

  test("deps transitives A→B→C → installe C puis B puis A", async () => {
    registryPackages.set("@acme/a", makeRegistryPkg("@acme", "a"));
    registryPackages.set("@acme/b", makeRegistryPkg("@acme", "b"));
    registryPackages.set("@acme/c", makeRegistryPkg("@acme", "c"));

    zipQueue.push(
      makeZipResult("skill", {
        displayName: "A",
        registryDependencies: { skills: { "@acme/b": "*" } },
      }),
    );
    zipQueue.push(
      makeZipResult("skill", {
        displayName: "B",
        registryDependencies: { skills: { "@acme/c": "*" } },
      }),
    );
    zipQueue.push(makeZipResult("skill", { displayName: "C" }));

    // A: findMissingDeps → B missing
    //   B: findMissingDeps → C missing
    //     C: no deps (no SELECT); existing check → INSERT
    //   B: existing check → INSERT
    // A: existing check → INSERT
    selectQueue = [
      [], // findMissingDeps for A → B missing
      [], // findMissingDeps for B → C missing
      [], // existing check for C → INSERT
      [], // existing check for B → INSERT
      [], // existing check for A → INSERT
    ];

    const result = await installFromMarketplace(
      "acme",
      "a",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    expect(insertedRows).toHaveLength(3);
    expect(insertedRows[0]!.id).toBe("@acme/c");
    expect(insertedRows[0]!.autoInstalled).toBe(true);
    expect(insertedRows[1]!.id).toBe("@acme/b");
    expect(insertedRows[1]!.autoInstalled).toBe(true);
    expect(insertedRows[2]!.id).toBe("@acme/a");
    expect(insertedRows[2]!.autoInstalled).toBe(false);

    // autoInstalledDeps order: collect phase pushes deepest deps first (C, then B)
    expect(result.autoInstalledDeps).toHaveLength(2);
    expect(result.autoInstalledDeps![0]!.packageId).toBe("@acme/c");
    expect(result.autoInstalledDeps![1]!.packageId).toBe("@acme/b");
  });

  test("dep circulaire A→B→A → skip avec warning", async () => {
    registryPackages.set("@acme/a", makeRegistryPkg("@acme", "a"));
    registryPackages.set("@acme/b", makeRegistryPkg("@acme", "b"));

    zipQueue.push(
      makeZipResult("skill", {
        displayName: "A",
        registryDependencies: { skills: { "@acme/b": "*" } },
      }),
    );
    zipQueue.push(
      makeZipResult("skill", {
        displayName: "B",
        registryDependencies: { skills: { "@acme/a": "*" } },
      }),
    );

    // A: findMissingDeps → B missing
    //   B: findMissingDeps → A returned as "missing" by DB, but visited set blocks install
    //   B: existing check → INSERT
    // A: existing check → INSERT
    selectQueue = [
      [], // findMissingDeps for A → B missing
      [], // findMissingDeps for B → A "missing" from DB (but visited blocks it)
      [], // existing check for B → INSERT
      [], // existing check for A → INSERT
    ];

    await installFromMarketplace("acme", "a", undefined, "org-1", "user-1", undefined);

    const circularWarns = warnCalls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Circular dependency"),
    );
    expect(circularWarns.length).toBeGreaterThanOrEqual(1);
    expect(insertedRows).toHaveLength(2);
  });

  test("dep déjà installée → update au lieu d'insert", async () => {
    registryPackages.set("@acme/parent", makeRegistryPkg("@acme", "parent"));
    registryPackages.set("@acme/dep", makeRegistryPkg("@acme", "dep"));

    zipQueue.push(
      makeZipResult("skill", {
        displayName: "Parent",
        registryDependencies: { skills: { "@acme/dep": "*" } },
      }),
    );
    zipQueue.push(makeZipResult("skill", { displayName: "Dep" }));

    // Parent: findMissingDeps → dep missing
    //   dep: no deps (no SELECT); existing check → ALREADY installed → UPDATE
    // Parent: existing check → not installed → INSERT
    selectQueue = [
      [], // findMissingDeps for parent → dep missing
      [{ id: "@acme/dep" }], // existing check for dep → UPDATE
      [], // existing check for parent → INSERT
    ];

    await installFromMarketplace("acme", "parent", undefined, "org-1", "user-1", undefined);

    expect(updatedSets).toHaveLength(1);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]!.id).toBe("@acme/parent");
  });

  test("update d'un package existant — le met à jour", async () => {
    registryPackages.set("@acme/existing", makeRegistryPkg("@acme", "existing"));
    zipQueue.push(makeZipResult("skill", { displayName: "Existing" }));

    // No deps → no SELECT for deps; existing check → already installed
    selectQueue = [
      [{ id: "@acme/existing" }], // existing check → UPDATE
    ];

    const result = await installFromMarketplace(
      "acme",
      "existing",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    expect(updatedSets).toHaveLength(1);
    expect(insertedRows).toHaveLength(0);
    expect(result.packageId).toBe("@acme/existing");
  });

  test("promotion auto→explicit — autoInstalled passe à false", async () => {
    registryPackages.set("@acme/promoted", makeRegistryPkg("@acme", "promoted"));
    zipQueue.push(makeZipResult("skill", { displayName: "Promoted" }));

    // No deps; existing check → already installed
    selectQueue = [
      [{ id: "@acme/promoted" }], // existing check → UPDATE
    ];

    // Direct install (ctx.autoInstalled=false) on existing package → promote to explicit
    await installFromMarketplace("acme", "promoted", undefined, "org-1", "user-1", undefined);

    expect(updatedSets).toHaveLength(1);
    // !ctx.autoInstalled is true → spread { autoInstalled: false } into the set
    expect(updatedSets[0]).toHaveProperty("autoInstalled", false);
  });

  test("jamais demotion explicit→auto — autoInstalled n'est PAS dans l'updateSet", async () => {
    // Install parent that depends on dep. Dep is already installed.
    // The recursive call for dep runs with ctx.autoInstalled=true.
    // The update of an existing dep should NOT set autoInstalled (no demotion).

    registryPackages.set("@acme/parent", makeRegistryPkg("@acme", "parent"));
    registryPackages.set("@acme/dep", makeRegistryPkg("@acme", "dep"));

    zipQueue.push(
      makeZipResult("skill", {
        displayName: "Parent",
        registryDependencies: { skills: { "@acme/dep": "*" } },
      }),
    );
    zipQueue.push(makeZipResult("skill", { displayName: "Dep" }));

    // Parent: findMissingDeps → dep missing
    // dep: no deps; existing check → ALREADY installed → UPDATE (with ctx.autoInstalled=true)
    // Parent: existing check → not installed → INSERT
    selectQueue = [
      [], // findMissingDeps for parent → dep missing
      [{ id: "@acme/dep" }], // existing check for dep → UPDATE
      [], // existing check for parent → INSERT
    ];

    await installFromMarketplace("acme", "parent", undefined, "org-1", "user-1", undefined);

    // dep was updated with ctx.autoInstalled=true
    // !ctx.autoInstalled is false → spread false is a no-op → autoInstalled NOT in set
    expect(updatedSets).toHaveLength(1);
    expect(updatedSets[0]).not.toHaveProperty("autoInstalled");
  });

  test("autoInstalledDeps inclut les deps transitives à plat", async () => {
    registryPackages.set("@acme/root", makeRegistryPkg("@acme", "root"));
    registryPackages.set("@acme/mid", makeRegistryPkg("@acme", "mid"));
    registryPackages.set("@acme/leaf", makeRegistryPkg("@acme", "leaf"));

    zipQueue.push(
      makeZipResult("skill", {
        displayName: "Root",
        registryDependencies: { skills: { "@acme/mid": "*" } },
      }),
    );
    zipQueue.push(
      makeZipResult("skill", {
        displayName: "Mid",
        registryDependencies: { skills: { "@acme/leaf": "*" } },
      }),
    );
    zipQueue.push(makeZipResult("skill", { displayName: "Leaf" }));

    selectQueue = [
      [], // findMissingDeps for root → mid missing
      [], // findMissingDeps for mid → leaf missing
      [], // existing check for leaf → INSERT
      [], // existing check for mid → INSERT
      [], // existing check for root → INSERT
    ];

    const result = await installFromMarketplace(
      "acme",
      "root",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    // autoInstalledDeps must be flat: root pushes [mid, ...mid.autoInstalledDeps(leaf)]
    expect(result.autoInstalledDeps).toHaveLength(2);
    const depIds = result.autoInstalledDeps!.map((d) => d.packageId);
    expect(depIds).toContain("@acme/leaf");
    expect(depIds).toContain("@acme/mid");
    // Each entry should be a simple object with 3 keys
    for (const dep of result.autoInstalledDeps!) {
      expect(dep).toHaveProperty("packageId");
      expect(dep).toHaveProperty("type");
      expect(dep).toHaveProperty("version");
      expect(Object.keys(dep)).toHaveLength(3);
    }
  });

  test("extension deps are also auto-installed", async () => {
    registryPackages.set("@acme/flow-pkg", makeRegistryPkg("@acme", "flow-pkg"));
    registryPackages.set("@acme/ext", makeRegistryPkg("@acme", "ext"));

    zipQueue.push(
      makeZipResult("flow", {
        displayName: "Flow",
        registryDependencies: { extensions: { "@acme/ext": "^1.0" } },
      }),
    );
    zipQueue.push(makeZipResult("extension", { displayName: "Ext" }));

    // flow: findMissingDeps → ext missing
    // ext: no deps; existing check → INSERT
    // flow: existing check → INSERT
    selectQueue = [
      [], // findMissingDeps for flow → ext missing
      [], // existing check for ext → INSERT
      [], // existing check for flow → INSERT
    ];

    const result = await installFromMarketplace(
      "acme",
      "flow-pkg",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]!.id).toBe("@acme/ext");
    expect(insertedRows[0]!.autoInstalled).toBe(true);
    expect(result.autoInstalledDeps).toHaveLength(1);
    expect(result.autoInstalledDeps![0]!.packageId).toBe("@acme/ext");
    expect(result.autoInstalledDeps![0]!.type).toBe("extension");
  });

  test("flow avec deps mixtes skill + extension au même niveau", async () => {
    registryPackages.set("@acme/my-flow", makeRegistryPkg("@acme", "my-flow"));
    registryPackages.set("@acme/skill-a", makeRegistryPkg("@acme", "skill-a"));
    registryPackages.set("@acme/ext-b", makeRegistryPkg("@acme", "ext-b"));

    zipQueue.push(
      makeZipResult("flow", {
        displayName: "My Flow",
        registryDependencies: {
          skills: { "@acme/skill-a": "*" },
          extensions: { "@acme/ext-b": "^1.0" },
        },
      }),
    );
    zipQueue.push(makeZipResult("skill", { displayName: "Skill A" }));
    zipQueue.push(makeZipResult("extension", { displayName: "Ext B" }));

    // flow: findMissingDeps → skill-a and ext-b both missing
    // skill-a: no deps; existing check → INSERT
    // ext-b: no deps; existing check → INSERT
    // flow: existing check → INSERT
    selectQueue = [
      [], // findMissingDeps for flow → both missing
      [], // existing check for skill-a → INSERT
      [], // existing check for ext-b → INSERT
      [], // existing check for flow → INSERT
    ];

    const result = await installFromMarketplace(
      "acme",
      "my-flow",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    expect(insertedRows).toHaveLength(3);
    expect(insertedRows[0]!.id).toBe("@acme/skill-a");
    expect(insertedRows[0]!.autoInstalled).toBe(true);
    expect(insertedRows[1]!.id).toBe("@acme/ext-b");
    expect(insertedRows[1]!.autoInstalled).toBe(true);
    expect(insertedRows[2]!.id).toBe("@acme/my-flow");
    expect(insertedRows[2]!.autoInstalled).toBe(false);

    expect(result.autoInstalledDeps).toHaveLength(2);
    const types = result.autoInstalledDeps!.map((d) => d.type);
    expect(types).toContain("skill");
    expect(types).toContain("extension");
  });

  test("deps parallèles — A dépend de B et C sans imbrication", async () => {
    registryPackages.set("@acme/parent", makeRegistryPkg("@acme", "parent"));
    registryPackages.set("@acme/b", makeRegistryPkg("@acme", "b"));
    registryPackages.set("@acme/c", makeRegistryPkg("@acme", "c"));

    zipQueue.push(
      makeZipResult("skill", {
        displayName: "Parent",
        registryDependencies: {
          skills: { "@acme/b": "*", "@acme/c": "*" },
        },
      }),
    );
    zipQueue.push(makeZipResult("skill", { displayName: "B" }));
    zipQueue.push(makeZipResult("skill", { displayName: "C" }));

    // parent: findMissingDeps → b and c missing
    // b: no deps; existing check → INSERT
    // c: no deps; existing check → INSERT
    // parent: existing check → INSERT
    selectQueue = [
      [], // findMissingDeps for parent → both missing
      [], // existing check for b → INSERT
      [], // existing check for c → INSERT
      [], // existing check for parent → INSERT
    ];

    const result = await installFromMarketplace(
      "acme",
      "parent",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    expect(insertedRows).toHaveLength(3);
    expect(insertedRows[0]!.id).toBe("@acme/b");
    expect(insertedRows[1]!.id).toBe("@acme/c");
    expect(insertedRows[2]!.id).toBe("@acme/parent");
    expect(result.autoInstalledDeps).toHaveLength(2);
  });

  test("diamond dependency A→B,C et B→D, C→D — D installé une seule fois", async () => {
    registryPackages.set("@acme/a", makeRegistryPkg("@acme", "a"));
    registryPackages.set("@acme/b", makeRegistryPkg("@acme", "b"));
    registryPackages.set("@acme/c", makeRegistryPkg("@acme", "c"));
    registryPackages.set("@acme/d", makeRegistryPkg("@acme", "d"));

    // A depends on B and C; B depends on D; C depends on D
    zipQueue.push(
      makeZipResult("skill", {
        displayName: "A",
        registryDependencies: { skills: { "@acme/b": "*", "@acme/c": "*" } },
      }),
    );
    zipQueue.push(
      makeZipResult("skill", {
        displayName: "B",
        registryDependencies: { skills: { "@acme/d": "*" } },
      }),
    );
    zipQueue.push(makeZipResult("skill", { displayName: "D" }));
    zipQueue.push(
      makeZipResult("skill", {
        displayName: "C",
        registryDependencies: { skills: { "@acme/d": "*" } },
      }),
    );

    // Phase A (collect): findMissingDeps queries only (no writes yet)
    //   A: findMissingDeps → B and C missing
    //   B: findMissingDeps → D missing
    //   D: no deps (no SELECT); pushed to collected
    //   B: pushed to collected
    //   C: findMissingDeps → D NOT in DB (no writes yet), but diamond dedup skips collect
    //   C: pushed to collected
    //   A: pushed to collected
    // Phase B (commit): collected = [D, B, C, A]
    //   D: existing check → INSERT
    //   B: existing check → INSERT
    //   C: existing check → INSERT
    //   A: existing check → INSERT
    selectQueue = [
      [], // findMissingDeps for A → B and C missing
      [], // findMissingDeps for B → D missing
      [], // findMissingDeps for C → D "missing" (not in DB yet, diamond dedup handles it)
      [], // existing check for D → INSERT
      [], // existing check for B → INSERT
      [], // existing check for C → INSERT
      [], // existing check for A → INSERT
    ];

    const result = await installFromMarketplace(
      "acme",
      "a",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    // D inserted once (by B's subtree), C sees it already installed
    expect(insertedRows).toHaveLength(4);
    expect(insertedRows[0]!.id).toBe("@acme/d");
    expect(insertedRows[1]!.id).toBe("@acme/b");
    expect(insertedRows[2]!.id).toBe("@acme/c");
    expect(insertedRows[3]!.id).toBe("@acme/a");

    // autoInstalledDeps: B (+ its transitive D), then C (D already handled)
    expect(result.autoInstalledDeps).toHaveLength(3);
    const depIds = result.autoInstalledDeps!.map((d) => d.packageId);
    expect(depIds).toContain("@acme/b");
    expect(depIds).toContain("@acme/c");
    expect(depIds).toContain("@acme/d");
  });

  test("dep circulaire à 3 niveaux A→B→C→A → skip avec warning", async () => {
    registryPackages.set("@acme/a", makeRegistryPkg("@acme", "a"));
    registryPackages.set("@acme/b", makeRegistryPkg("@acme", "b"));
    registryPackages.set("@acme/c", makeRegistryPkg("@acme", "c"));

    zipQueue.push(
      makeZipResult("skill", {
        displayName: "A",
        registryDependencies: { skills: { "@acme/b": "*" } },
      }),
    );
    zipQueue.push(
      makeZipResult("skill", {
        displayName: "B",
        registryDependencies: { skills: { "@acme/c": "*" } },
      }),
    );
    zipQueue.push(
      makeZipResult("skill", {
        displayName: "C",
        registryDependencies: { skills: { "@acme/a": "*" } },
      }),
    );

    // A: findMissingDeps → B missing
    //   B: findMissingDeps → C missing
    //     C: findMissingDeps → A "missing" from DB, but visited={acme--a, acme--b} blocks it
    //     C: existing check → INSERT
    //   B: existing check → INSERT
    // A: existing check → INSERT
    selectQueue = [
      [], // findMissingDeps for A → B missing
      [], // findMissingDeps for B → C missing
      [], // findMissingDeps for C → A "missing" (visited blocks)
      [], // existing check for C → INSERT
      [], // existing check for B → INSERT
      [], // existing check for A → INSERT
    ];

    await installFromMarketplace("acme", "a", undefined, "org-1", "user-1", undefined);

    const circularWarns = warnCalls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Circular dependency"),
    );
    expect(circularWarns.length).toBeGreaterThanOrEqual(1);
    // All 3 installed despite the cycle (A already being installed, just skipped as dep of C)
    expect(insertedRows).toHaveLength(3);
    expect(insertedRows[0]!.id).toBe("@acme/c");
    expect(insertedRows[1]!.id).toBe("@acme/b");
    expect(insertedRows[2]!.id).toBe("@acme/a");
  });

  test("dep introuvable dans le registry → throw", async () => {
    registryPackages.set("@acme/parent", makeRegistryPkg("@acme", "parent"));
    // @acme/ghost is NOT in the registry

    zipQueue.push(
      makeZipResult("skill", {
        displayName: "Parent",
        registryDependencies: { skills: { "@acme/ghost": "*" } },
      }),
    );

    // parent: findMissingDeps → ghost missing
    // ghost: client.getPackage returns null → throws before any DB query
    selectQueue = [
      [], // findMissingDeps for parent → ghost missing
    ];

    await expect(
      installFromMarketplace("acme", "parent", undefined, "org-1", "user-1", undefined),
    ).rejects.toThrow("not found in registry");

    // Nothing should have been inserted (error during dep resolution)
    expect(insertedRows).toHaveLength(0);
  });

  test("flow → skill → extension — deps cross-type imbriquées", async () => {
    registryPackages.set("@acme/my-flow", makeRegistryPkg("@acme", "my-flow"));
    registryPackages.set("@acme/my-skill", makeRegistryPkg("@acme", "my-skill"));
    registryPackages.set("@acme/my-ext", makeRegistryPkg("@acme", "my-ext"));

    zipQueue.push(
      makeZipResult("flow", {
        displayName: "My Flow",
        registryDependencies: { skills: { "@acme/my-skill": "*" } },
      }),
    );
    zipQueue.push(
      makeZipResult("skill", {
        displayName: "My Skill",
        registryDependencies: { extensions: { "@acme/my-ext": "^1.0" } },
      }),
    );
    zipQueue.push(makeZipResult("extension", { displayName: "My Ext" }));

    // flow: findMissingDeps → skill missing
    //   skill: findMissingDeps → ext missing
    //     ext: no deps; existing check → INSERT
    //   skill: existing check → INSERT
    // flow: existing check → INSERT
    selectQueue = [
      [], // findMissingDeps for flow → skill missing
      [], // findMissingDeps for skill → ext missing
      [], // existing check for ext → INSERT
      [], // existing check for skill → INSERT
      [], // existing check for flow → INSERT
    ];

    const result = await installFromMarketplace(
      "acme",
      "my-flow",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    expect(insertedRows).toHaveLength(3);
    expect(insertedRows[0]!.id).toBe("@acme/my-ext");
    expect(insertedRows[0]!.type).toBe("extension");
    expect(insertedRows[0]!.autoInstalled).toBe(true);
    expect(insertedRows[1]!.id).toBe("@acme/my-skill");
    expect(insertedRows[1]!.type).toBe("skill");
    expect(insertedRows[1]!.autoInstalled).toBe(true);
    expect(insertedRows[2]!.id).toBe("@acme/my-flow");
    expect(insertedRows[2]!.type).toBe("flow");
    expect(insertedRows[2]!.autoInstalled).toBe(false);

    // autoInstalledDeps: collect phase pushes deepest deps first (ext, then skill)
    expect(result.autoInstalledDeps).toHaveLength(2);
    expect(result.autoInstalledDeps![0]!.packageId).toBe("@acme/my-ext");
    expect(result.autoInstalledDeps![0]!.type).toBe("extension");
    expect(result.autoInstalledDeps![1]!.packageId).toBe("@acme/my-skill");
    expect(result.autoInstalledDeps![1]!.type).toBe("skill");
  });
});
