import { describe, test, expect, mock, beforeEach } from "bun:test";
import { queues, resetQueues, tracking, db, schemaStubs } from "./_db-mock.ts";

// --- Mocks (must be before dynamic import) ---

const noop = () => {};
mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));
mock.module("@appstrate/db/schema", () => ({ ...schemaStubs }));

// --- Dynamic import (after mocks) ---

const {
  createApplication,
  createDefaultApplication,
  getDefaultApplication,
  listApplications,
  getApplication,
  updateApplication,
  deleteApplication,
  ensureDefaultApplications,
} = await import("../applications.ts");

// --- Helpers ---

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: "app_test-uuid",
    orgId: "org-1",
    name: "Test App",
    isDefault: false,
    settings: {},
    createdBy: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

beforeEach(() => {
  resetQueues();
});

// ---------------------------------------------------------------------------
// createApplication
// ---------------------------------------------------------------------------

describe("createApplication", () => {
  test("inserts with correct orgId and returns the created app", async () => {
    const app = makeApp();
    queues.insert.push([app]);

    const result = await createApplication("org-1", { name: "Test App" });

    expect(result).toEqual(app);
    expect(tracking.insertCalls).toHaveLength(1);
    expect(tracking.insertCalls[0]!.orgId).toBe("org-1");
    expect(tracking.insertCalls[0]!.name).toBe("Test App");
  });

  test("generates an app_ prefixed ID", async () => {
    const app = makeApp();
    queues.insert.push([app]);

    await createApplication("org-1", { name: "Test App" });

    const inserted = tracking.insertCalls[0]!;
    expect(typeof inserted.id).toBe("string");
    expect((inserted.id as string).startsWith("app_")).toBe(true);
  });

  test("defaults isDefault to false", async () => {
    queues.insert.push([makeApp()]);

    await createApplication("org-1", { name: "No Default" });

    expect(tracking.insertCalls[0]!.isDefault).toBe(false);
  });

  test("defaults settings to empty object", async () => {
    queues.insert.push([makeApp()]);

    await createApplication("org-1", { name: "No Settings" });

    expect(tracking.insertCalls[0]!.settings).toEqual({});
  });

  test("passes createdBy when provided", async () => {
    queues.insert.push([makeApp({ createdBy: "user-1" })]);

    await createApplication("org-1", { name: "App", isDefault: true }, "user-1");

    expect(tracking.insertCalls[0]!.createdBy).toBe("user-1");
    expect(tracking.insertCalls[0]!.isDefault).toBe(true);
  });

  test("sets createdBy to null when not provided", async () => {
    queues.insert.push([makeApp()]);

    await createApplication("org-1", { name: "App" });

    expect(tracking.insertCalls[0]!.createdBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createDefaultApplication
// ---------------------------------------------------------------------------

describe("createDefaultApplication", () => {
  test("returns existing default if one already exists (idempotent)", async () => {
    const existing = makeApp({ id: "app_existing", isDefault: true });
    queues.select.push([existing]);

    const result = await createDefaultApplication("org-1");

    expect(result).toEqual(existing);
    // No insert should have been made
    expect(tracking.insertCalls).toHaveLength(0);
  });

  test("creates a new default application when none exists", async () => {
    queues.select.push([]); // no existing default
    const created = makeApp({ name: "Default", isDefault: true });
    queues.insert.push([created]);

    const result = await createDefaultApplication("org-1");

    expect(result).toEqual(created);
    expect(tracking.insertCalls).toHaveLength(1);
    expect(tracking.insertCalls[0]!.name).toBe("Default");
    expect(tracking.insertCalls[0]!.isDefault).toBe(true);
  });

  test("passes createdBy to the created application", async () => {
    queues.select.push([]);
    queues.insert.push([makeApp({ name: "Default", isDefault: true, createdBy: "user-42" })]);

    await createDefaultApplication("org-1", "user-42");

    expect(tracking.insertCalls[0]!.createdBy).toBe("user-42");
  });
});

// ---------------------------------------------------------------------------
// getDefaultApplication
// ---------------------------------------------------------------------------

describe("getDefaultApplication", () => {
  test("returns the default application when it exists", async () => {
    const app = makeApp({ isDefault: true });
    queues.select.push([app]);

    const result = await getDefaultApplication("org-1");

    expect(result).toEqual(app);
  });

  test("throws 404 if no default exists", async () => {
    queues.select.push([]);

    await expect(getDefaultApplication("org-1")).rejects.toThrow("Default application not found");
  });
});

// ---------------------------------------------------------------------------
// listApplications
// ---------------------------------------------------------------------------

describe("listApplications", () => {
  test("returns list filtered by orgId", async () => {
    const apps = [
      makeApp({ id: "app_1", name: "First" }),
      makeApp({ id: "app_2", name: "Second" }),
    ];
    queues.select.push(apps);

    const result = await listApplications("org-1");

    expect(result).toEqual(apps);
    expect(result).toHaveLength(2);
  });

  test("returns empty list when no applications exist", async () => {
    queues.select.push([]);

    const result = await listApplications("org-1");

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getApplication
// ---------------------------------------------------------------------------

describe("getApplication", () => {
  test("returns the app when orgId matches", async () => {
    const app = makeApp({ id: "app_abc" });
    queues.select.push([app]);

    const result = await getApplication("org-1", "app_abc");

    expect(result).toEqual(app);
  });

  test("throws 404 when not found", async () => {
    queues.select.push([]);

    await expect(getApplication("org-1", "app_unknown")).rejects.toThrow("Application not found");
  });
});

// ---------------------------------------------------------------------------
// updateApplication
// ---------------------------------------------------------------------------

describe("updateApplication", () => {
  test("partial update with name only", async () => {
    const updated = makeApp({ name: "Renamed" });
    queues.update.push([updated]);

    const result = await updateApplication("org-1", "app_abc", { name: "Renamed" });

    expect(result).toEqual(updated);
    expect(tracking.updateCalls).toHaveLength(1);
    expect(tracking.updateCalls[0]!.name).toBe("Renamed");
  });

  test("partial update with settings only", async () => {
    const updated = makeApp({ settings: { theme: "dark" } });
    queues.update.push([updated]);

    const result = await updateApplication("org-1", "app_abc", {
      settings: { theme: "dark" },
    });

    expect(result).toEqual(updated);
    expect(tracking.updateCalls[0]!.settings).toEqual({ theme: "dark" });
  });

  test("sets updatedAt on update", async () => {
    queues.update.push([makeApp()]);

    await updateApplication("org-1", "app_abc", { name: "X" });

    expect(tracking.updateCalls[0]!.updatedAt).toBeInstanceOf(Date);
  });

  test("throws 404 for unknown application", async () => {
    queues.update.push([]);

    await expect(updateApplication("org-1", "app_unknown", { name: "Nope" })).rejects.toThrow(
      "Application not found",
    );
  });
});

// ---------------------------------------------------------------------------
// deleteApplication
// ---------------------------------------------------------------------------

describe("deleteApplication", () => {
  test("deletes a non-default application", async () => {
    queues.select.push([{ id: "app_abc", isDefault: false }]);

    await expect(deleteApplication("org-1", "app_abc")).resolves.toBeUndefined();
    expect(tracking.deleteCalls).toHaveLength(1);
  });

  test("throws 400 if isDefault is true", async () => {
    queues.select.push([{ id: "app_default", isDefault: true }]);

    await expect(deleteApplication("org-1", "app_default")).rejects.toThrow(
      "Cannot delete default application",
    );
  });

  test("throws 404 if not found", async () => {
    queues.select.push([]);

    await expect(deleteApplication("org-1", "app_unknown")).rejects.toThrow(
      "Application not found",
    );
  });
});

// ---------------------------------------------------------------------------
// ensureDefaultApplications
// ---------------------------------------------------------------------------

describe("ensureDefaultApplications", () => {
  test("creates defaults for orgs missing them", async () => {
    // First select: list all orgs
    queues.select.push([{ id: "org-1" }, { id: "org-2" }]);
    // Second select: org-1 has a default
    queues.select.push([{ id: "app_existing" }]);
    // Third select: org-2 has no default
    queues.select.push([]);
    // createDefaultApplication for org-2: select (no existing) + insert
    queues.select.push([]);
    queues.insert.push([makeApp({ orgId: "org-2", isDefault: true })]);

    await ensureDefaultApplications();

    // Only one insert (org-2 needed a default, org-1 already had one)
    expect(tracking.insertCalls).toHaveLength(1);
    expect(tracking.insertCalls[0]!.orgId).toBe("org-2");
    expect(tracking.insertCalls[0]!.isDefault).toBe(true);
  });

  test("does nothing when all orgs already have defaults", async () => {
    queues.select.push([{ id: "org-1" }]);
    queues.select.push([{ id: "app_existing" }]);

    await ensureDefaultApplications();

    expect(tracking.insertCalls).toHaveLength(0);
  });

  test("does nothing when no orgs exist", async () => {
    queues.select.push([]);

    await ensureDefaultApplications();

    expect(tracking.insertCalls).toHaveLength(0);
  });
});
