// SPDX-License-Identifier: Apache-2.0

/**
 * A package the deployment already activates everywhere takes no offer
 * (`active_by_default`, `org_offerable`), and an integration bound to the
 * runtime cannot be deactivated (`runtime_bound` verdict, `400` on the door).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { orgPackageOffers, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPublishedVersion, seedSpace } from "../../helpers/seed.ts";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";
import {
  _setSystemPackagesForTesting,
  type SystemPackageEntry,
} from "../../../src/services/system-packages.ts";

const app = getTestApp();

/** Runtime-bound: serves the run's own tools. */
const BOUND = "@appstrate/probe-platform";
/** In `SYSTEM_INTEGRATIONS`, not runtime-bound. */
const LISTED = "@appstrate/probe-listed";
/** A catalogue integration the deployment ships but does not activate. */
const CATALOGUE = "@appstrate/probe-catalogue";
/** Published by the organization, homed in a space, and named in `SYSTEM_INTEGRATIONS`. */
const ORG_LISTED = "@testorg/probe-org-listed";

const manifestOf = (id: string, meta?: Record<string, unknown>) => ({
  name: id,
  version: "1.0.0",
  type: "integration",
  ...(meta ? { _meta: meta } : {}),
});

const registryEntry = (id: string, manifest: Record<string, unknown>) =>
  ({
    packageId: id,
    scope: "@appstrate",
    name: id.split("/")[1],
    type: "integration",
    version: "1.0.0",
    manifest,
    zipBuffer: Buffer.alloc(0),
    content: "",
    files: {},
  }) as unknown as SystemPackageEntry;

let ctx: TestContext;
let restoreRegistry: () => void;

interface LibraryEntry {
  id: string;
  org_offerable: boolean;
  active_by_default: boolean;
  placements: { space_id: string; via: string }[];
  activation: { spaceId: string; deactivate: string }[];
}

async function libraryEntry(
  id: string,
  spaceId: string = ctx.defaultSpaceId,
): Promise<LibraryEntry> {
  const res = await app.request(`/api/spaces/${spaceId}/library`, {
    headers: authHeaders({ ...ctx, defaultSpaceId: spaceId }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { packages: { integration: LibraryEntry[] } };
  return body.packages.integration.find((entry) => entry.id === id)!;
}

const offer = (id: string) =>
  app.request(`/api/packages/${id}/org-offer`, { method: "PUT", headers: authHeaders(ctx) });
const deactivate = (id: string) =>
  app.request(`/api/spaces/${ctx.defaultSpaceId}/packages/${id}`, {
    method: "DELETE",
    headers: authHeaders(ctx),
  });
const rowsOf = (id: string) =>
  db.select().from(spacePackages).where(eq(spacePackages.packageId, id));

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  const bound = manifestOf(BOUND, { "dev.appstrate/platform": {} });
  restoreRegistry = _setSystemPackagesForTesting(new Map([[BOUND, registryEntry(BOUND, bound)]]));
  __resetSystemIntegrationsForTest();
  initSystemIntegrations([
    { id: LISTED, clients: [] },
    { id: ORG_LISTED, clients: [] },
  ]);
  for (const [id, manifest] of [
    [BOUND, bound],
    [LISTED, manifestOf(LISTED)],
    [CATALOGUE, manifestOf(CATALOGUE)],
  ] as const) {
    await seedPackage({
      id,
      orgId: null,
      type: "integration",
      source: "system",
      draftManifest: manifest,
    });
  }
});

afterEach(() => {
  restoreRegistry();
  __resetSystemIntegrationsForTest();
});

describe("a package active by default takes no offer", () => {
  it("refuses the offer and reports it unofferable", async () => {
    const res = await offer(LISTED);
    await expectProblem(res, 400, { code: "invalid_request" });
    expect(await db.select().from(orgPackageOffers)).toHaveLength(0);
    expect(await libraryEntry(LISTED)).toMatchObject({
      org_offerable: false,
      active_by_default: true,
    });
  });

  it("keeps a catalogue integration offerable", async () => {
    expect(await libraryEntry(CATALOGUE)).toMatchObject({
      org_offerable: true,
      active_by_default: false,
    });
    expect((await offer(CATALOGUE)).status).toBe(200);
  });
});

describe("a runtime-bound integration cannot be deactivated", () => {
  it("answers 400, writes no row and says runtime_bound", async () => {
    await expectProblem(await deactivate(BOUND), 400, { code: "invalid_request" });
    expect(await rowsOf(BOUND)).toHaveLength(0);
    const entry = await libraryEntry(BOUND);
    expect(entry.active_by_default).toBe(true);
    expect(entry.activation.find((cell) => cell.spaceId === ctx.defaultSpaceId)?.deactivate).toBe(
      "runtime_bound",
    );
  });

  it("still deactivates a listed system integration that is not runtime-bound", async () => {
    expect((await deactivate(LISTED)).status).toBe(204);
    expect(await rowsOf(LISTED)).toMatchObject([{ enabled: false }]);
  });
});

describe("an organization-published integration named in SYSTEM_INTEGRATIONS", () => {
  it("stays offerable: the deployment places it in no other space", async () => {
    await seedPackage({
      id: ORG_LISTED,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifestOf(ORG_LISTED),
    });
    await seedPublishedVersion(ORG_LISTED, "1.0.0");
    const second = await seedSpace({ orgId: ctx.orgId, name: "Second" });
    expect((await libraryEntry(ORG_LISTED, second.id)).placements).toHaveLength(0);

    expect(await libraryEntry(ORG_LISTED)).toMatchObject({
      org_offerable: true,
      active_by_default: false,
    });
    expect((await offer(ORG_LISTED)).status).toBe(200);
    expect(await db.select().from(orgPackageOffers)).toHaveLength(1);

    const seen = await libraryEntry(ORG_LISTED, second.id);
    expect(seen.placements).toMatchObject([{ space_id: second.id, via: "organization" }]);
  });
});
