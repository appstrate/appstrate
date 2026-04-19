// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock } from "bun:test";
import {
  DockerAddressPoolExhaustedError,
  classifyDockerNetworkError,
  createNetworkWithPoolRetry,
} from "../../src/services/docker-errors.ts";

const POOL_BODY = `{"message":"all predefined address pools have been fully subnetted"}`;

describe("classifyDockerNetworkError", () => {
  it("returns DockerAddressPoolExhaustedError on the Moby ErrNoMoreSubnets message", () => {
    const err = classifyDockerNetworkError(400, POOL_BODY);
    expect(err).toBeInstanceOf(DockerAddressPoolExhaustedError);
    expect(err?.code).toBe("DOCKER_ADDRESS_POOL_EXHAUSTED");
    expect(err?.cause).toBe(POOL_BODY);
  });

  it("returns null when status is not 400 (guard against pathological bodies)", () => {
    expect(classifyDockerNetworkError(500, POOL_BODY)).toBeNull();
    expect(classifyDockerNetworkError(409, POOL_BODY)).toBeNull();
  });

  it("returns null when body does not match the ErrNoMoreSubnets pattern", () => {
    expect(classifyDockerNetworkError(400, `{"message":"network name already in use"}`)).toBeNull();
    expect(classifyDockerNetworkError(400, "")).toBeNull();
  });

  it("surfaces a user-actionable remediation in the error message", () => {
    const err = new DockerAddressPoolExhaustedError(POOL_BODY);
    expect(err.message).toContain("docker network prune");
    expect(err.message).toContain("default-address-pools");
    expect(err.message).toContain("docker-network-pool-tuning");
  });
});

describe("createNetworkWithPoolRetry", () => {
  it("returns the network id on first-try success without calling cleanup", async () => {
    const create = mock(() => Promise.resolve("net-ok"));
    const cleanup = mock(() => Promise.resolve(0));
    const id = await createNetworkWithPoolRetry(create, cleanup);
    expect(id).toBe("net-ok");
    expect(create).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("propagates non-pool errors unchanged without attempting cleanup", async () => {
    const create = mock(() => Promise.reject(new Error("docker daemon unreachable")));
    const cleanup = mock(() => Promise.resolve(0));
    await expect(createNetworkWithPoolRetry(create, cleanup)).rejects.toThrow(/daemon unreachable/);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("runs cleanup and retries once when cleanup frees networks", async () => {
    let calls = 0;
    const create = mock(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new DockerAddressPoolExhaustedError(POOL_BODY));
      return Promise.resolve("net-after-retry");
    });
    const cleanup = mock(() => Promise.resolve(3));
    const id = await createNetworkWithPoolRetry(create, cleanup);
    expect(id).toBe("net-after-retry");
    expect(create).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not retry when cleanup reclaims zero networks (retry guaranteed to fail)", async () => {
    const create = mock(() => Promise.reject(new DockerAddressPoolExhaustedError(POOL_BODY)));
    const cleanup = mock(() => Promise.resolve(0));
    await expect(createNetworkWithPoolRetry(create, cleanup)).rejects.toBeInstanceOf(
      DockerAddressPoolExhaustedError,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("re-throws the pool error when the second attempt also fails", async () => {
    const create = mock(() => Promise.reject(new DockerAddressPoolExhaustedError(POOL_BODY)));
    const cleanup = mock(() => Promise.resolve(5));
    await expect(createNetworkWithPoolRetry(create, cleanup)).rejects.toBeInstanceOf(
      DockerAddressPoolExhaustedError,
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("forwards warn logs so ops can trace the cleanup path", async () => {
    const warn = mock(() => {});
    const create = mock(() => Promise.reject(new DockerAddressPoolExhaustedError(POOL_BODY)));
    const cleanup = mock(() => Promise.resolve(0));
    await expect(createNetworkWithPoolRetry(create, cleanup, { warn })).rejects.toBeInstanceOf(
      DockerAddressPoolExhaustedError,
    );
    expect(warn).toHaveBeenCalled();
  });
});
