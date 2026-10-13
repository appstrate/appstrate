// SPDX-License-Identifier: Apache-2.0

/**
 * A model's test answers `NEEDS_RECONNECTION` when its credential is dead. The
 * generic sentence for that code speaks of an integration connection and its
 * owner, which is false for a model credential.
 */

import { describe, it, expect } from "bun:test";
import { MODEL_TEST_FAILURE_KEYS, testFailureKey } from "../test-result.ts";

describe("testFailureKey", () => {
  it("names the model's own sentence for a credential to reconnect, as the server spells the code", () => {
    expect(
      testFailureKey({ ok: false, error: "NEEDS_RECONNECTION" }, MODEL_TEST_FAILURE_KEYS),
    ).toBe("models.credentialUnavailableHint");
  });

  it("leaves every other failure to the generic sentence", () => {
    expect(
      testFailureKey({ ok: false, error: "AUTH_FAILED" }, MODEL_TEST_FAILURE_KEYS),
    ).toBeUndefined();
    expect(testFailureKey({ ok: false }, MODEL_TEST_FAILURE_KEYS)).toBeUndefined();
    expect(
      testFailureKey({ ok: false, error: "toString" }, MODEL_TEST_FAILURE_KEYS),
    ).toBeUndefined();
  });

  it("names nothing for a passed test, nor for a surface with no sentence of its own", () => {
    expect(
      testFailureKey({ ok: true, error: "NEEDS_RECONNECTION" }, MODEL_TEST_FAILURE_KEYS),
    ).toBeUndefined();
    expect(testFailureKey({ ok: false, error: "NEEDS_RECONNECTION" }, undefined)).toBeUndefined();
  });
});
