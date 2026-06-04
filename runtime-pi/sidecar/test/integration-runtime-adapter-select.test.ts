// SPDX-License-Identifier: Apache-2.0

/**
 * E5 — selectIntegrationRuntimeAdapter registry + selection error branches.
 *
 * The registry is module-level (a singleton array inside
 * integration-runtime-adapter.ts). To avoid leaking registrations across
 * test files, every test here registers adapters under DISTINCT,
 * test-only ids (never "docker"/"process", which the real adapter modules
 * register on import). Duplicate-registration is asserted with its own
 * unique id so the assertion is hermetic regardless of import order.
 *
 * Runs fully in-process — no Docker, no PostgreSQL.
 */

import { describe, it, expect } from "bun:test";
import {
  registerIntegrationRuntimeAdapter,
  selectIntegrationRuntimeAdapter,
  buildMitmEnvBlock,
  type IntegrationRuntimeAdapter,
} from "../integration-runtime-adapter.ts";

function fakeAdapter(id: string): IntegrationRuntimeAdapter {
  return {
    id,
    async prepare() {
      return { listenerBindHost: "127.0.0.1", proxyUrlFor: (p: number) => `http://127.0.0.1:${p}` };
    },
    async spawn() {
      throw new Error("not spawned in this test");
    },
    async shutdown() {},
  };
}

let unique = 0;
function uniqueId(prefix: string): string {
  unique += 1;
  return `${prefix}-${unique}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("selectIntegrationRuntimeAdapter", () => {
  it("returns the registered adapter selected by INTEGRATION_RUNTIME_ADAPTER", () => {
    const id = uniqueId("test-select");
    registerIntegrationRuntimeAdapter({ id, create: () => fakeAdapter(id) });

    const adapter = selectIntegrationRuntimeAdapter({
      INTEGRATION_RUNTIME_ADAPTER: id,
    } as NodeJS.ProcessEnv);

    expect(adapter.id).toBe(id);
  });

  it("throws when INTEGRATION_RUNTIME_ADAPTER is unset", () => {
    // At least one adapter is registered by the real modules being imported,
    // so the "no adapter registered" branch is not what we exercise here.
    const id = uniqueId("test-unset");
    registerIntegrationRuntimeAdapter({ id, create: () => fakeAdapter(id) });

    expect(() => selectIntegrationRuntimeAdapter({} as NodeJS.ProcessEnv)).toThrow(
      /INTEGRATION_RUNTIME_ADAPTER is not set/,
    );
  });

  it("throws when INTEGRATION_RUNTIME_ADAPTER names an unregistered adapter", () => {
    // Register one (distinct) adapter so the registry is non-empty — we want
    // the "not registered" branch, not the "no adapter registered" branch.
    const present = uniqueId("test-present");
    registerIntegrationRuntimeAdapter({ id: present, create: () => fakeAdapter(present) });

    const id = uniqueId("test-unknown");
    expect(() =>
      selectIntegrationRuntimeAdapter({
        INTEGRATION_RUNTIME_ADAPTER: id,
      } as NodeJS.ProcessEnv),
    ).toThrow(/not registered/);
  });

  it("throws on duplicate registration of the same id", () => {
    const id = uniqueId("test-dup");
    registerIntegrationRuntimeAdapter({ id, create: () => fakeAdapter(id) });
    expect(() => registerIntegrationRuntimeAdapter({ id, create: () => fakeAdapter(id) })).toThrow(
      /already registered/,
    );
  });
});

describe("buildMitmEnvBlock", () => {
  it("returns the standard proxy + CA trust-store env shape", () => {
    const proxyUrl = "http://sidecar:39472";
    const caPath = "/tmp/appstrate-ca.pem";
    const env = buildMitmEnvBlock(proxyUrl, caPath);

    expect(env).toEqual({
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      http_proxy: proxyUrl,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: caPath,
      SSL_CERT_FILE: caPath,
      REQUESTS_CA_BUNDLE: caPath,
      CURL_CA_BUNDLE: caPath,
      GIT_SSL_CAINFO: caPath,
    });
  });

  it("threads distinct proxy + CA paths through unchanged", () => {
    const env = buildMitmEnvBlock("http://127.0.0.1:8080", "/host/path/ca.pem");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8080");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/host/path/ca.pem");
    expect(env.REQUESTS_CA_BUNDLE).toBe("/host/path/ca.pem");
  });
});
