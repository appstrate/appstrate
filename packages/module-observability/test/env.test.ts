// SPDX-License-Identifier: Apache-2.0

/**
 * OTel env parsing unit tests. This module owns its env handling (the core
 * schema carries no `OTEL_*` vars) — these tests pin the parse semantics that
 * used to live in `@appstrate/env`: boolEnv coercion, the empty-endpoint
 * compose pattern, and the enabled-state derivation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readOtelEnv } from "../src/env.ts";

const VARS = [
  "OTEL_ENABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SERVICE_NAME",
  "OTEL_TRUST_INCOMING_TRACE",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("readOtelEnv", () => {
  it("defaults: disabled, no endpoint, appstrate-api service, untrusted inbound", () => {
    const env = readOtelEnv();
    expect(env.enabled).toBe(false);
    expect(env.endpoint).toBeUndefined();
    expect(env.serviceName).toBe("appstrate-api");
    expect(env.trustIncomingTrace).toBe(false);
  });

  it("enables via OTEL_ENABLED with boolEnv semantics (true/1, case-insensitive)", () => {
    for (const truthy of ["true", "TRUE", "1"]) {
      process.env.OTEL_ENABLED = truthy;
      expect(readOtelEnv().enabled).toBe(true);
    }
    for (const falsy of ["false", "0", "yes", ""]) {
      process.env.OTEL_ENABLED = falsy;
      expect(readOtelEnv().enabled).toBe(false);
    }
  });

  it("enables via a non-empty endpoint; empty string reads as unset (compose `${VAR:-}`)", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
    expect(readOtelEnv().enabled).toBe(true);
    expect(readOtelEnv().endpoint).toBe("http://collector:4318");

    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "";
    expect(readOtelEnv().enabled).toBe(false);
    expect(readOtelEnv().endpoint).toBeUndefined();
  });

  it("parses the trust flag with the same boolEnv semantics", () => {
    process.env.OTEL_TRUST_INCOMING_TRACE = "1";
    expect(readOtelEnv().trustIncomingTrace).toBe(true);
    process.env.OTEL_TRUST_INCOMING_TRACE = "false";
    expect(readOtelEnv().trustIncomingTrace).toBe(false);
  });

  it("honors a custom service name", () => {
    process.env.OTEL_SERVICE_NAME = "my-api";
    expect(readOtelEnv().serviceName).toBe("my-api");
  });
});
