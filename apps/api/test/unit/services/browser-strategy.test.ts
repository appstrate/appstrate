// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { _test } from "../../../src/services/connect/browser-strategy.ts";
import { buildBrowserRunStartHttpPlaceholder } from "../../../src/services/integration-spawn-resolver.ts";

describe("browser acquisition result policy", () => {
  it("requires an authenticated proof before exposing outputs", () => {
    expect(() =>
      _test.validateAcquisitionResult(
        { outputs: { cookie: "sid=x" }, proof: { kind: "", succeeded: true } },
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/authenticated proof/);
  });

  it("rejects every output not declared by connect.produces", () => {
    expect(() =>
      _test.validateAcquisitionResult(
        {
          outputs: { cookie: "sid=x", unexpected_token: "secret" },
          proof: { kind: "account-page", succeeded: true },
        },
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/undeclared output 'unexpected_token'/);
  });

  it("validates the decrypted result shape again before persistence", () => {
    expect(() =>
      _test.validateAcquisitionResult(
        {
          outputs: { cookie: 42 },
          proof: { kind: "account-page", succeeded: true },
        } as never,
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/malformed output 'cookie'/);
    expect(() =>
      _test.validateAcquisitionResult(
        {
          outputs: { cookie: "sid=x" },
          proof: { kind: "account-page", succeeded: true },
          expiresAt: "not-a-date",
        },
        ["cookie"],
        "exportable",
      ),
    ).toThrow(/invalid expiration/);
  });

  it("allows an output-free browser-bound proof but not an empty exportable session", () => {
    const result = {
      outputs: {},
      proof: { kind: "account-page", succeeded: true as const },
    };
    expect(_test.validateAcquisitionResult(result, [], "browser-bound")).toEqual({ outputs: {} });
    expect(() => _test.validateAcquisitionResult(result, [], "exportable")).toThrow(
      /no injectable output/,
    );
  });

  it("fails closed for link-time browser-bound sessions until state leases exist", () => {
    expect(() => _test.assertSupportedLinkSessionMode("browser-bound")).toThrow(
      /runtime-state store and lease service/,
    );
    expect(() => _test.assertSupportedLinkSessionMode("exportable")).not.toThrow();
  });
});

describe("run-start exportable delivery", () => {
  it("creates the blank MITM/source plan that acquisition replaces in-run", () => {
    expect(
      buildBrowserRunStartHttpPlaceholder({
        authKey: "session",
        authType: "custom",
        authorizedUris: ["https://api.example.com/**"],
        deliveryHttp: {
          in: "header",
          name: "Cookie",
          value: "{$credential.cookie}",
        },
      }),
    ).toEqual({
      session: {
        authType: "custom",
        headerName: "Cookie",
        headerPrefix: "",
        value: "",
        allowServerOverride: false,
        authorizedUris: ["https://api.example.com/**"],
        expiresAtEpochMs: null,
      },
    });
  });
});
