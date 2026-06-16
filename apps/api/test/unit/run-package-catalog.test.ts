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
 *   - `fetch` routes to whichever catalog `resolve` used.
 */

import { describe, it, expect } from "bun:test";
import { RunPackageCatalog } from "../../src/services/run-launcher/run-package-catalog.ts";
import type {
  BundlePackage,
  PackageCatalog,
  PackageIdentity,
  ResolvedPackage,
} from "@appstrate/afps-runtime/bundle";

/** A recording fake catalog: notes the (name, spec) it was asked to resolve. */
class FakeCatalog implements PackageCatalog {
  readonly resolveCalls: Array<{ name: string; spec: string }> = [];
  readonly fetchCalls: PackageIdentity[] = [];
  constructor(private readonly label: string) {}

  async resolve(name: string, versionSpec: string): Promise<ResolvedPackage | null> {
    this.resolveCalls.push({ name, spec: versionSpec });
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

function make(overrides?: Record<string, string>) {
  const db = new FakeCatalog("db");
  const draft = new FakeCatalog("draft");
  let draftConstructed = 0;
  const catalog = new RunPackageCatalog({
    orgId: "00000000-0000-0000-0000-000000000000",
    ...(overrides ? { dependencyOverrides: overrides } : {}),
    deps: {
      db,
      makeDraft: () => {
        draftConstructed++;
        return draft;
      },
    },
  });
  return { catalog, db, draft, draftConstructed: () => draftConstructed };
}

describe("RunPackageCatalog — routing", () => {
  it("resolves with no override via the DB catalog using the manifest pin", async () => {
    const { catalog, db, draft } = make();
    const r = await catalog.resolve("@s/skill", "^1.0.0");
    expect(r?.identity).toBe("@s/skill@db");
    expect(db.resolveCalls).toEqual([{ name: "@s/skill", spec: "^1.0.0" }]);
    expect(draft.resolveCalls).toEqual([]);
  });

  it("an explicit spec override REPLACES the manifest pin (still DB/published)", async () => {
    const { catalog, db } = make({ "@s/skill": "2.3.4" });
    await catalog.resolve("@s/skill", "^1.0.0");
    // The DB catalog sees the override spec, not the manifest's `^1.0.0`.
    expect(db.resolveCalls).toEqual([{ name: "@s/skill", spec: "2.3.4" }]);
  });

  it("a `draft` override routes the dep to the draft catalog", async () => {
    const { catalog, db, draft } = make({ "@s/skill": "draft" });
    const r = await catalog.resolve("@s/skill", "^1.0.0");
    expect(r?.identity).toBe("@s/skill@draft");
    expect(draft.resolveCalls).toEqual([{ name: "@s/skill", spec: "^1.0.0" }]);
    expect(db.resolveCalls).toEqual([]);
  });

  it("only constructs the draft catalog when a `draft` override is actually used", async () => {
    const noDraft = make({ "@s/skill": "^1.0.0" });
    await noDraft.catalog.resolve("@s/skill", "^1.0.0");
    expect(noDraft.draftConstructed()).toBe(0);

    const withDraft = make({ "@s/skill": "draft" });
    await withDraft.catalog.resolve("@s/skill", "^1.0.0");
    expect(withDraft.draftConstructed()).toBe(1);
  });

  it("fetch routes to whichever catalog resolved the identity", async () => {
    const { catalog, db, draft } = make({ "@s/drafted": "draft" });
    const dbResolved = await catalog.resolve("@s/published", "^1.0.0");
    const draftResolved = await catalog.resolve("@s/drafted", "^1.0.0");

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

  it("returns null (propagating an unresolved dep) when the DB catalog can't resolve", async () => {
    const db = new FakeCatalog("db");
    db.resolve = async () => null;
    const catalog = new RunPackageCatalog({
      orgId: "00000000-0000-0000-0000-000000000000",
      deps: { db },
    });
    expect(await catalog.resolve("@s/ghost", "^1.0.0")).toBeNull();
  });
});
