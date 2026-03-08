import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  queues,
  resetQueues,
  db,
  schemaStubs,
  builtinPackagesStub,
  packageStorageStub,
  registryClientStub,
} from "./_db-mock.ts";

// Registry provider mock — controls forward-only version check via getPackage
let mockRegistryProviderClient: { getPackage: ReturnType<typeof mock> } | null = null;

// --- Mocks ---

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));
mock.module("@appstrate/db/schema", () => schemaStubs);
mock.module("../builtin-packages.ts", () => builtinPackagesStub);
const mockDownloadVersionZip = mock(async () => null as Buffer | null);
mock.module("../package-storage.ts", () => ({
  ...packageStorageStub,
  downloadVersionZip: mockDownloadVersionZip,
}));
mock.module("@appstrate/registry-client", () => registryClientStub);
mock.module("../registry-provider.ts", () => ({
  getRegistryClient: () => mockRegistryProviderClient,
  isRegistryConfigured: () => !!mockRegistryProviderClient,
  getRegistryDiscovery: () => null,
  initRegistryProvider: async () => {},
}));

// --- Service mocks ---

let mockRegistryClient: { publish: ReturnType<typeof mock> } | null = null;

mock.module("../registry-auth.ts", () => ({
  getAuthenticatedRegistryClient: async () => mockRegistryClient,
}));

mock.module("../package-items/index.ts", () => ({
  getFlowItemFiles: async () => new Map(),
  downloadPackageFiles: async () => null,
  SKILL_CONFIG: {},
  EXTENSION_CONFIG: {},
  FLOW_CONFIG: {},
}));

mock.module("../flow-service.ts", () => ({
  getPackage: async () => ({ prompt: "test", skills: [], extensions: [] }),
  isBuiltInFlow: () => false,
  getAllPackageIds: async () => [],
}));

mock.module("../package-items/dependencies.ts", () => ({
  buildRegistryDependencies: async () => null,
}));

mock.module("@appstrate/core/zip", () => ({
  zipArtifact: () => new Uint8Array(10),
  unzipArtifact: () => ({}),
}));

// --- Import after mocks ---

const { publishPackage, PublishValidationError } = await import("../registry-publish.ts");

// --- Helpers ---

function makePackageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "@acme/my-flow",
    type: "flow",
    name: "My Flow",
    orgId: "org-1",
    manifest: { name: "@acme/my-flow", version: "1.0.0" },
    source: "local",
    content: null,
    ...overrides,
  };
}

function makeVersionRow(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0.0",
    manifest: { name: "@acme/my-flow", version: "1.0.0" },
    yanked: false,
    integrity: "sha256-abc",
    ...overrides,
  };
}

const publishResult = {
  scope: "acme",
  name: "my-flow",
  version: "1.0.0",
  integrity: "sha256-abc",
  size: 100,
  type: "flow",
};

const fakeZip = Buffer.from("fake-zip-content");

// --- Tests ---

describe("publishPackage", () => {
  beforeEach(() => {
    resetQueues();
    mockRegistryClient = { publish: mock(async () => publishResult) };
    // Default: no versions published on registry (first publish)
    mockRegistryProviderClient = {
      getPackage: mock(async () => {
        throw new Error("Not found");
      }),
    };
    mockDownloadVersionZip.mockImplementation(async () => fakeZip);
  });

  test("throws when registry not connected", async () => {
    mockRegistryClient = null;
    expect(publishPackage("pkg-1", "org-1", "user-1")).rejects.toThrow("Not connected to registry");
  });

  test("throws when package not found", async () => {
    queues.select = [[]];
    expect(publishPackage("pkg-1", "org-1", "user-1")).rejects.toThrow("not found");
  });

  test("throws when package is built-in", async () => {
    queues.select = [[makePackageRow({ source: "built-in" })]];
    expect(publishPackage("@acme/my-flow", "org-1", "user-1")).rejects.toThrow(
      "Cannot publish built-in",
    );
  });

  test("throws VERSION_REQUIRED when no targetVersion", async () => {
    queues.select = [[makePackageRow()]];
    const err = await publishPackage("@acme/my-flow", "org-1", "user-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishValidationError);
    expect((err as InstanceType<typeof PublishValidationError>).code).toBe("VERSION_REQUIRED");
  });

  test("throws VERSION_NOT_FOUND for missing targetVersion", async () => {
    queues.select = [
      [makePackageRow()],
      [], // packageVersions empty
    ];
    const err = await publishPackage("@acme/my-flow", "org-1", "user-1", "2.0.0").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishValidationError);
    expect((err as InstanceType<typeof PublishValidationError>).code).toBe("VERSION_NOT_FOUND");
  });

  test("throws VERSION_YANKED for yanked version", async () => {
    queues.select = [
      [makePackageRow()],
      [
        {
          version: "2.0.0",
          manifest: { name: "@acme/my-flow", version: "2.0.0" },
          yanked: true,
          integrity: "sha256-x",
        },
      ],
    ];
    const err = await publishPackage("@acme/my-flow", "org-1", "user-1", "2.0.0").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishValidationError);
    expect((err as InstanceType<typeof PublishValidationError>).code).toBe("VERSION_YANKED");
  });

  test("throws VERSION_ZIP_MISSING when zip not found", async () => {
    queues.select = [
      [makePackageRow()],
      [
        {
          version: "2.0.0",
          manifest: { name: "@acme/my-flow", version: "2.0.0" },
          yanked: false,
          integrity: "sha256-x",
        },
      ],
    ];
    mockDownloadVersionZip.mockImplementation(async () => null);
    const err = await publishPackage("@acme/my-flow", "org-1", "user-1", "2.0.0").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishValidationError);
    expect((err as InstanceType<typeof PublishValidationError>).code).toBe("VERSION_ZIP_MISSING");
  });

  test("throws VERSION_MISSING when manifest has no version", async () => {
    queues.select = [[makePackageRow()], [makeVersionRow({ manifest: { name: "@acme/my-flow" } })]];
    const err = await publishPackage("@acme/my-flow", "org-1", "user-1", "1.0.0").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishValidationError);
    expect((err as InstanceType<typeof PublishValidationError>).code).toBe("VERSION_MISSING");
  });

  test("throws VERSION_INVALID for invalid semver", async () => {
    queues.select = [
      [makePackageRow()],
      [makeVersionRow({ manifest: { name: "@acme/my-flow", version: "abc" } })],
    ];
    const err = await publishPackage("@acme/my-flow", "org-1", "user-1", "1.0.0").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishValidationError);
    expect((err as InstanceType<typeof PublishValidationError>).code).toBe("VERSION_INVALID");
  });

  test("throws VERSION_NOT_HIGHER when version not greater", async () => {
    queues.select = [
      [makePackageRow()],
      [makeVersionRow({ manifest: { name: "@acme/my-flow", version: "1.0.0" } })],
    ];
    // Registry already has version 2.0.0 published
    mockRegistryProviderClient = {
      getPackage: mock(async () => ({ versions: [{ version: "2.0.0", yanked: false }] })),
    };
    const err = await publishPackage("@acme/my-flow", "org-1", "user-1", "1.0.0").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishValidationError);
    expect((err as InstanceType<typeof PublishValidationError>).code).toBe("VERSION_NOT_HIGHER");
  });

  test("throws VERSION_EXISTS when version already published", async () => {
    queues.select = [
      [makePackageRow()],
      [makeVersionRow({ manifest: { name: "@acme/my-flow", version: "1.0.0" } })],
    ];
    // Registry already has version 1.0.0 published
    mockRegistryProviderClient = {
      getPackage: mock(async () => ({ versions: [{ version: "1.0.0", yanked: false }] })),
    };
    const err = await publishPackage("@acme/my-flow", "org-1", "user-1", "1.0.0").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishValidationError);
    expect((err as InstanceType<typeof PublishValidationError>).code).toBe("VERSION_EXISTS");
  });

  test("successful publish completes without DB update", async () => {
    queues.select = [[makePackageRow()], [makeVersionRow()]];
    const result = await publishPackage("@acme/my-flow", "org-1", "user-1", "1.0.0");
    expect(result).toEqual(publishResult);
  });

  test("publishes skill type", async () => {
    queues.select = [
      [makePackageRow({ type: "skill", manifest: { name: "@acme/my-skill", version: "1.0.0" } })],
      [makeVersionRow({ manifest: { name: "@acme/my-skill", version: "1.0.0" } })],
    ];
    const result = await publishPackage("@acme/my-skill", "org-1", "user-1", "1.0.0");
    expect(result).toEqual(publishResult);
    expect(mockRegistryClient!.publish).toHaveBeenCalledTimes(1);
  });

  test("publishes extension type", async () => {
    queues.select = [
      [
        makePackageRow({
          type: "extension",
          manifest: { name: "@acme/my-ext", version: "1.0.0" },
        }),
      ],
      [makeVersionRow({ manifest: { name: "@acme/my-ext", version: "1.0.0" } })],
    ];
    const result = await publishPackage("@acme/my-ext", "org-1", "user-1", "1.0.0");
    expect(result).toEqual(publishResult);
  });

  test("RegistryClientError 409 maps to REGISTRY_CONFLICT", async () => {
    queues.select = [[makePackageRow()], [makeVersionRow()]];
    mockRegistryClient = {
      publish: mock(async () => {
        throw new registryClientStub.RegistryClientError(409, "CONFLICT", "Already exists");
      }),
    };
    const err = await publishPackage("@acme/my-flow", "org-1", "user-1", "1.0.0").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishValidationError);
    expect((err as InstanceType<typeof PublishValidationError>).code).toBe("REGISTRY_CONFLICT");
  });
});
