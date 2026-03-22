/**
 * Tests for the flow override data layer (getFlowOverrides, setFlowModelId, setFlowProxyId)
 * and the execution cascade logic (buildExecutionContext merging request → flow → resolve).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { db, queues, tracking, resetQueues, schemaStubs } from "./_db-mock.ts";

// --- Mocks (before dynamic imports) ---

const noop = () => {};
mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));
mock.module("../../lib/db.ts", () => ({ db }));
mock.module("@appstrate/db/schema", () => ({
  ...schemaStubs,
  packageConfigs: {
    orgId: "org_id",
    packageId: "package_id",
    config: "config",
    modelId: "model_id",
    proxyId: "proxy_id",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
}));

const { getFlowOverrides, setFlowModelId, setFlowProxyId } =
  await import("../state/package-config.ts");

// --- Tests ---

beforeEach(() => {
  resetQueues();
});

// ============================
// getFlowOverrides
// ============================

describe("getFlowOverrides", () => {
  test("returns modelId and proxyId from DB row", async () => {
    queues.select.push([{ modelId: "model-1", proxyId: "proxy-1" }]);

    const result = await getFlowOverrides("org-1", "flow-1");
    expect(result).toEqual({ modelId: "model-1", proxyId: "proxy-1" });
  });

  test("returns nulls when row does not exist", async () => {
    queues.select.push([]);

    const result = await getFlowOverrides("org-1", "flow-1");
    expect(result).toEqual({ modelId: null, proxyId: null });
  });

  test("returns nulls when columns are null", async () => {
    queues.select.push([{ modelId: null, proxyId: null }]);

    const result = await getFlowOverrides("org-1", "flow-1");
    expect(result).toEqual({ modelId: null, proxyId: null });
  });

  test("returns partial values (modelId set, proxyId null)", async () => {
    queues.select.push([{ modelId: "model-1", proxyId: null }]);

    const result = await getFlowOverrides("org-1", "flow-1");
    expect(result).toEqual({ modelId: "model-1", proxyId: null });
  });
});

// ============================
// setFlowModelId
// ============================

describe("setFlowModelId", () => {
  test("upserts modelId value", async () => {
    await setFlowModelId("org-1", "flow-1", "model-abc");

    expect(tracking.insertCalls).toHaveLength(1);
    const call = tracking.insertCalls[0]!;
    expect(call.modelId).toBe("model-abc");
    expect(call.orgId).toBe("org-1");
    expect(call.packageId).toBe("flow-1");
    expect(call.config).toEqual({});
  });

  test("upserts null to clear override", async () => {
    await setFlowModelId("org-1", "flow-1", null);

    expect(tracking.insertCalls).toHaveLength(1);
    expect(tracking.insertCalls[0]!.modelId).toBeNull();
  });
});

// ============================
// setFlowProxyId
// ============================

describe("setFlowProxyId", () => {
  test("upserts proxyId value", async () => {
    await setFlowProxyId("org-1", "flow-1", "proxy-abc");

    expect(tracking.insertCalls).toHaveLength(1);
    const call = tracking.insertCalls[0]!;
    expect(call.proxyId).toBe("proxy-abc");
    expect(call.orgId).toBe("org-1");
    expect(call.packageId).toBe("flow-1");
  });

  test("upserts 'none' to disable proxy", async () => {
    await setFlowProxyId("org-1", "flow-1", "none");

    expect(tracking.insertCalls).toHaveLength(1);
    expect(tracking.insertCalls[0]!.proxyId).toBe("none");
  });

  test("upserts null to clear override", async () => {
    await setFlowProxyId("org-1", "flow-1", null);

    expect(tracking.insertCalls).toHaveLength(1);
    expect(tracking.insertCalls[0]!.proxyId).toBeNull();
  });
});

// ============================
// Cascade logic (unit test via ?? operator)
// ============================

describe("override cascade", () => {
  test("request override takes priority over flow column", () => {
    const requestModelId: string | undefined = "request-model";
    const flowModelId: string | null = "flow-model";

    const effective = requestModelId ?? flowModelId;
    expect(effective).toBe("request-model");
  });

  test("flow column used when request override is undefined", () => {
    const requestModelId: string | undefined = undefined;
    const flowModelId: string | null = "flow-model";

    const effective = requestModelId ?? flowModelId;
    expect(effective).toBe("flow-model");
  });

  test("null propagates when both are absent", () => {
    const requestModelId: string | undefined = undefined;
    const flowModelId: string | null = null;

    const effective = requestModelId ?? flowModelId;
    expect(effective).toBeNull();
  });

  test("'none' passes through from request", () => {
    const requestProxyId: string | undefined = "none";
    const flowProxyId: string | null = "flow-proxy";

    const effective = requestProxyId ?? flowProxyId;
    expect(effective).toBe("none");
  });

  test("'none' passes through from flow column", () => {
    const requestProxyId: string | undefined = undefined;
    const flowProxyId: string | null = "none";

    const effective = requestProxyId ?? flowProxyId;
    expect(effective).toBe("none");
  });
});
