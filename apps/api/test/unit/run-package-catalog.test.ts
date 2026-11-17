// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the routing logic of {@link RunPackageCatalog} (#666).
 *
 * The full resolve+fetch path hits the DB and storage; that integration path
 * is exercised by `services/build-agent-package-bundle.test.ts`. Here we inject
 * stand-in catalogs (the repo's no-`mock.module` DI policy) and verify the
 * pure routing decisions:
 *   - no override → manifest pin against the DB (published) catalog;
 *   - explicit spec override → replaces the pin, still DB;
 *   - `draft` override → the draft catalog, lazily constructed;
 *   - `fetch` routes to whichever catalog `resolve` used;
 *   - the `integrations` section answers only from the run's frozen versions.
 */

import { describe, it, expect } from "bun:test";
import { zipSync } from "fflate";
import { RunPackageCatalog } from "../../src/services/run-launcher/run-package-catalog.ts";
import type { ResolvedIntegrationVersionMap } from "../../src/services/integration-service.ts";
import type {
  BundlePackage,
  DependencySection,
  PackageCatalog,
  PackageIdentity,
  ResolvedPackage,
} from "@appstrate/afps-runtime/bundle";

/** A recording fake catalog: notes the (name, spec, section) it was asked to resolve. */
class FakeCatalog implements PackageCatalog {
  readonly resolveCalls: Array<{ name: string; spec: string; section: DependencySection }> = [];
  readonly fetchCalls: PackageIdentity[] = [];
  constructor(private readonly label: string) {}

  async resolve(
    name: string,
    versionSpec: string,
    section: DependencySection,
  ): Promise<ResolvedPackage | null> {
    this.resolveCalls.push({ name, spec: versionSpec, section });
    // Encode the resolving catalog into the identity version so fetch routing
    // is observable: `@s/n@<label>`.
    return {
      identity: `${name}@${this.label}` as PackageIdentity,
      integrity: "",
    };
  }

  async fetch(identity: PackageIdentity): Promise<BundlePackage> {
    this.fetchCalls.push(identity);
    return {
      identity,
      manifest: { resolvedBy: this.label },
      files: new Map(),
      integrity: "",
    };
  }
}

type SystemArchive = { version: string; zipBuffer: Buffer };

/** A system integration archive as the boot registry holds it. */
function systemArchive(id: string, version: string): SystemArchive {
  const manifest = { name: id, version, type: "integration", schema_version: "0.2" };
  const zip = zipSync({
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    "INTEGRATION.md": new TextEncoder().encode(`# ${id} ${version}\n`),
  });
  return { version, zipBuffer: Buffer.from(zip) };
}

function make(
  overrides?: Record<string, string>,
  integrationVersions: ResolvedIntegrationVersionMap = {},
  systemRegistry: Record<string, SystemArchive> = {},
) {
  const db = new FakeCatalog("db");
  const draft = new FakeCatalog("draft");
  let draftConstructed = 0;
  const catalog = new RunPackageCatalog({
    orgId: "00000000-0000-0000-0000-000000000000",
    ...(overrides ? { dependencyOverrides: overrides } : {}),
    integrationVersions,
    forExecution: true,
    deps: {
      db,
      makeDraft: () => {
        draftConstructed++;
        return draft;
      },
      systemPackage: (id) => systemRegistry[id],
    },
  });
  return { catalog, db, draft, draftConstructed: () => draftConstructed };
}

describe("RunPackageCatalog — routing", () => {
  it("resolves with no override via the DB catalog using the manifest pin", async () => {
    const { catalog, db, draft } = make();
    const r = await catalog.resolve("@s/skill", "^1.0.0", "skills");
    expect(r?.identity).toBe("@s/skill@db");
    expect(db.resolveCalls).toEqual([{ name: "@s/skill", spec: "^1.0.0", section: "skills" }]);
    expect(draft.resolveCalls).toEqual([]);
  });

  it("an explicit spec override REPLACES the manifest pin (still DB/published)", async () => {
    const { catalog, db } = make({ "@s/skill": "2.3.4" });
    await catalog.resolve("@s/skill", "^1.0.0", "skills");
    // The DB catalog sees the override spec, not the manifest's `^1.0.0`.
    expect(db.resolveCalls).toEqual([{ name: "@s/skill", spec: "2.3.4", section: "skills" }]);
  });

  it("a `draft` override routes the dep to the draft catalog", async () => {
    const { catalog, db, draft } = make({ "@s/skill": "draft" });
    const r = await catalog.resolve("@s/skill", "^1.0.0", "skills");
    expect(r?.identity).toBe("@s/skill@draft");
    expect(draft.resolveCalls).toEqual([{ name: "@s/skill", spec: "^1.0.0", section: "skills" }]);
    expect(db.resolveCalls).toEqual([]);
  });

  it("only constructs the draft catalog when a `draft` override is actually used", async () => {
    const noDraft = make({ "@s/skill": "^1.0.0" });
    await noDraft.catalog.resolve("@s/skill", "^1.0.0", "skills");
    expect(noDraft.draftConstructed()).toBe(0);

    const withDraft = make({ "@s/skill": "draft" });
    await withDraft.catalog.resolve("@s/skill", "^1.0.0", "skills");
    expect(withDraft.draftConstructed()).toBe(1);
  });

  it("fetch routes to whichever catalog resolved the identity", async () => {
    const { catalog, db, draft } = make({ "@s/drafted": "draft" });
    const dbResolved = await catalog.resolve("@s/published", "^1.0.0", "skills");
    const draftResolved = await catalog.resolve("@s/drafted", "^1.0.0", "skills");

    await catalog.fetch(dbResolved!.identity);
    await catalog.fetch(draftResolved!.identity);

    expect(db.fetchCalls).toEqual(["@s/published@db"]);
    expect(draft.fetchCalls).toEqual(["@s/drafted@draft"]);
  });

  it("fetch for an un-resolved identity falls back to the DB catalog", async () => {
    const { catalog, db } = make();
    await catalog.fetch("@s/never-resolved@9.9.9" as PackageIdentity);
    expect(db.fetchCalls).toEqual(["@s/never-resolved@9.9.9"]);
  });

  it("fetch THROWS on an owner-miss for a draft-overridden dep (never silently serves published)", async () => {
    // Builder fetches an identity it never resolved through us (owner miss) for
    // a dep the caller pinned to `draft`. A DB fallback would serve PUBLISHED
    // bytes — refuse loudly instead so a draft override can't silently degrade.
    const { catalog, db } = make({ "@s/drafted": "draft" });
    await expect(catalog.fetch("@s/drafted@1.0.0" as PackageIdentity)).rejects.toThrow(
      /draft-overridden/,
    );
    expect(db.fetchCalls).toEqual([]);
  });

  it("returns null (propagating an unresolved dep) when the DB catalog can't resolve", async () => {
    const db = new FakeCatalog("db");
    db.resolve = async () => null;
    const catalog = new RunPackageCatalog({
      orgId: "00000000-0000-0000-0000-000000000000",
      integrationVersions: {},
      forExecution: true,
      deps: { db },
    });
    expect(await catalog.resolve("@s/ghost", "^1.0.0", "skills")).toBeNull();
  });
});

describe("RunPackageCatalog — integrations section", () => {
  it("resolves a frozen `version` entry at that exact version, not the manifest pin", async () => {
    const { catalog, db, draft } = make(undefined, {
      "@s/int": { version: "1.2.3", source: "version" },
    });
    const r = await catalog.resolve("@s/int", "^1.0.0", "integrations");
    expect(r?.identity).toBe("@s/int@db");
    expect(db.resolveCalls).toEqual([{ name: "@s/int", spec: "1.2.3", section: "integrations" }]);
    expect(draft.resolveCalls).toEqual([]);
  });

  it("routes a frozen `draft` entry to the draft catalog", async () => {
    const { catalog, db, draft } = make(undefined, {
      "@s/int": { version: null, source: "draft" },
    });
    const r = await catalog.resolve("@s/int", "^1.0.0", "integrations");
    expect(r?.identity).toBe("@s/int@draft");
    expect(draft.resolveCalls).toHaveLength(1);
    expect(db.resolveCalls).toEqual([]);

    await catalog.fetch(r!.identity);
    expect(draft.fetchCalls).toEqual(["@s/int@draft"]);
  });

  it("serves a frozen `system` entry from the registry archive, never the DB", async () => {
    const archive = systemArchive("@system/int", "4.5.6");
    const { catalog, db, draftConstructed } = make(
      undefined,
      { "@system/int": { version: null, source: "system" } },
      { "@system/int": archive },
    );
    const r = await catalog.resolve("@system/int", "*", "integrations");
    expect(r?.identity).toBe("@system/int@4.5.6");

    const member = await catalog.fetch(r!.identity);
    expect(member.identity).toBe("@system/int@4.5.6");
    expect(new TextDecoder().decode(member.files.get("INTEGRATION.md"))).toBe(
      "# @system/int 4.5.6\n",
    );
    expect(member.manifest).toMatchObject({ name: "@system/int", version: "4.5.6" });
    expect(db.resolveCalls).toEqual([]);
    expect(db.fetchCalls).toEqual([]);
    expect(draftConstructed()).toBe(0);
  });

  it("returns null for a `system` entry the registry no longer holds", async () => {
    const { catalog, db } = make(undefined, {
      "@system/int": { version: null, source: "system" },
    });
    expect(await catalog.resolve("@system/int", "*", "integrations")).toBeNull();
    expect(db.resolveCalls).toEqual([]);
  });

  it("returns null for an integration absent from the freeze", async () => {
    const { catalog, db, draft } = make();
    expect(await catalog.resolve("@s/int", "^1.0.0", "integrations")).toBeNull();
    expect(db.resolveCalls).toEqual([]);
    expect(draft.resolveCalls).toEqual([]);
  });

  it("ignores dependencyOverrides for integrations (the freeze already applied them)", async () => {
    const pinned = make(
      { "@s/int": "draft" },
      { "@s/int": { version: "1.0.0", source: "version" } },
    );
    await pinned.catalog.resolve("@s/int", "^1.0.0", "integrations");
    expect(pinned.db.resolveCalls).toEqual([
      { name: "@s/int", spec: "1.0.0", section: "integrations" },
    ]);
    expect(pinned.draftConstructed()).toBe(0);

    const absent = make({ "@s/int": "2.0.0" });
    expect(await absent.catalog.resolve("@s/int", "^1.0.0", "integrations")).toBeNull();
    expect(absent.db.resolveCalls).toEqual([]);
  });

  it("throws on a corrupt frozen `version` entry with no version", async () => {
    const { catalog } = make(undefined, { "@s/int": { version: null, source: "version" } });
    await expect(catalog.resolve("@s/int", "^1.0.0", "integrations")).rejects.toThrow(
      /Corrupt frozen integration version/,
    );
  });

  it("leaves skills on the manifest pin even when the freeze names the same id", async () => {
    const { catalog, db } = make(undefined, {
      "@s/skill": { version: "9.9.9", source: "version" },
    });
    await catalog.resolve("@s/skill", "^1.0.0", "skills");
    await catalog.resolve("@s/skill", "^1.0.0", "skills");
    expect(db.resolveCalls).toEqual([
      { name: "@s/skill", spec: "^1.0.0", section: "skills" },
      { name: "@s/skill", spec: "^1.0.0", section: "skills" },
    ]);
  });

  it("fetch THROWS on an owner-miss for an integration frozen as draft", async () => {
    const { catalog, db } = make(undefined, { "@s/int": { version: null, source: "draft" } });
    await expect(catalog.fetch("@s/int@1.0.0" as PackageIdentity)).rejects.toThrow(
      /draft-overridden/,
    );
    expect(db.fetchCalls).toEqual([]);
  });
});
