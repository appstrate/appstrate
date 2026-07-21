// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { _test } from "../../../src/services/connect/browser-strategy.ts";
import {
  buildBrowserRunStartHttpPlaceholder,
  selectPersistedBrowserState,
} from "../../../src/services/integration-spawn-resolver.ts";

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

  it("requires injectable output only for exportable sessions", () => {
    const result = {
      outputs: {},
      proof: { kind: "account-page", succeeded: true as const },
    };
    expect(_test.validateAcquisitionResult(result, [], "browser-bound")).toEqual({ outputs: {} });
    expect(() => _test.validateAcquisitionResult(result, [], "exportable")).toThrow(
      /no injectable output/,
    );
  });

  it("accepts a declared bounded browser state", () => {
    expect(
      _test.validateAcquisitionResult(
        {
          outputs: { browser_state: '{"version":1,"cookies":[],"origins":[]}' },
          proof: { kind: "browser-state", succeeded: true },
        },
        ["browser_state"],
        "exportable",
      ),
    ).toEqual({ outputs: { browser_state: '{"version":1,"cookies":[],"origins":[]}' } });
  });

  it("keeps link-time browser-bound sessions disabled without a lease service", () => {
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

describe("link-time exportable browser state", () => {
  it("passes only declared non-empty state back to the private driver", () => {
    expect(
      selectPersistedBrowserState(
        { browser_state: "encrypted-output", unexpected: "must-not-cross" },
        ["browser_state"],
      ),
    ).toEqual({ browser_state: "encrypted-output" });
    expect(selectPersistedBrowserState({}, ["browser_state"])).toBeNull();
    expect(selectPersistedBrowserState({ browser_state: "" }, ["browser_state"])).toBeNull();
  });
});
