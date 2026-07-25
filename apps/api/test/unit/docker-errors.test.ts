// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock } from "bun:test";
import {
  DockerAddressPoolExhaustedError,
  classifyDockerNetworkError,
  createContainerWithImagePull,
  createNetworkWithPoolRetry,
  isMissingImageError,
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

const MISSING_IMAGE_BODY = `{"message":"No such image: ghcr.io/appstrate/appstrate-pi:1.0.0-beta.40"}`;

/** Build the Docker response shape for a create call. */
const missingImage = () => new Response(MISSING_IMAGE_BODY, { status: 404 });
const created = () => new Response(`{"Id":"ctr-1"}`, { status: 201 });

describe("isMissingImageError", () => {
  it("matches the Moby `No such image` 404 emitted by POST /containers/create", () => {
    expect(isMissingImageError(404, MISSING_IMAGE_BODY)).toBe(true);
  });

  it("matches regardless of the reference shape in the suffix", () => {
    expect(isMissingImageError(404, `{"message":"No such image: alpine (tag: latest)"}`)).toBe(
      true,
    );
    expect(isMissingImageError(404, `{"message":"No such image: sha256:abc123"}`)).toBe(true);
  });

  it("does not match other 404s from the same endpoint (pulling would not fix them)", () => {
    expect(isMissingImageError(404, `{"message":"network appstrate-egress not found"}`)).toBe(
      false,
    );
    expect(isMissingImageError(404, `{"message":"No such container: abc"}`)).toBe(false);
  });

  it("does not match a non-404 status carrying the same wording", () => {
    expect(isMissingImageError(500, MISSING_IMAGE_BODY)).toBe(false);
    expect(isMissingImageError(409, MISSING_IMAGE_BODY)).toBe(false);
  });

  it("returns false on a non-JSON or empty body instead of throwing", () => {
    expect(isMissingImageError(404, "")).toBe(false);
    expect(isMissingImageError(404, "<html>404 not found</html>")).toBe(false);
    expect(isMissingImageError(404, `{"message":42}`)).toBe(false);
  });
});

describe("createContainerWithImagePull", () => {
  it("returns the success response without pulling", async () => {
    const create = mock(() => Promise.resolve(created()));
    const pull = mock(() => Promise.resolve());
    const res = await createContainerWithImagePull(create, pull);
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
  });

  it("pulls and retries once when the image was pruned from under the process", async () => {
    let calls = 0;
    const create = mock(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? missingImage() : created());
    });
    const pull = mock(() => Promise.resolve());
    const res = await createContainerWithImagePull(create, pull);
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(2);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("retries at most once — a second miss is a bad reference, not a cold cache", async () => {
    const create = mock(() => Promise.resolve(missingImage()));
    const pull = mock(() => Promise.resolve());
    const res = await createContainerWithImagePull(create, pull);
    expect(res.status).toBe(404);
    expect(create).toHaveBeenCalledTimes(2);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("leaves the response body readable for the caller's error handler", async () => {
    // The helper inspects the body via clone(); the original must stay unread
    // so `assertDockerOk` can still report the verbatim Docker message.
    const create = mock(() => Promise.resolve(missingImage()));
    const pull = mock(() => Promise.resolve());
    const res = await createContainerWithImagePull(create, pull);
    await expect(res.text()).resolves.toBe(MISSING_IMAGE_BODY);
  });

  it("passes through a non-image 404 untouched, without pulling", async () => {
    const body = `{"message":"network appstrate-egress not found"}`;
    const create = mock(() => Promise.resolve(new Response(body, { status: 404 })));
    const pull = mock(() => Promise.resolve());
    const res = await createContainerWithImagePull(create, pull);
    expect(res.status).toBe(404);
    await expect(res.text()).resolves.toBe(body);
    expect(create).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
  });

  it("propagates a pull failure so the run fails with the registry's reason", async () => {
    const create = mock(() => Promise.resolve(missingImage()));
    const pull = mock(() => Promise.reject(new Error("manifest unknown")));
    await expect(createContainerWithImagePull(create, pull)).rejects.toThrow(/manifest unknown/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("forwards warn logs so ops can trace the heal path", async () => {
    const warn = mock(() => {});
    const create = mock(() => Promise.resolve(missingImage()));
    const pull = mock(() => Promise.resolve());
    await createContainerWithImagePull(create, pull, { warn });
    expect(warn).toHaveBeenCalled();
  });
});
