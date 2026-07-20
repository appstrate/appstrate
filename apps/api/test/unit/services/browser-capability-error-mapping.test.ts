// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { BrowserCapabilityPolicyError } from "../../../src/services/browser-capability-grants.ts";
import { toBrowserCapabilityApiError } from "../../../src/services/browser-capability-error-mapping.ts";

describe("browser capability error mapping", () => {
  it("maps a policy refusal to a stable non-retryable API error", () => {
    const mapped = toBrowserCapabilityApiError(
      new BrowserCapabilityPolicyError("driver grant is not authorized"),
    );

    expect(mapped).toMatchObject({
      status: 403,
      code: "browser_policy_denied",
      title: "Browser Policy Denied",
      message: "driver grant is not authorized",
    });
  });

  it("does not relabel unrelated failures", () => {
    expect(toBrowserCapabilityApiError(new Error("boom"))).toBeNull();
  });

  it("maps sanitized runtime codes without copying driver-controlled detail", () => {
    const mapped = toBrowserCapabilityApiError(
      new Error("connect-run failed: BROWSER_CRASHED password=hunter2"),
    );
    expect(mapped).toMatchObject({ status: 503, code: "browser_crashed" });
    expect(mapped?.message).not.toContain("hunter2");
  });

  it("maps worker saturation to a retryable resource-limit response", () => {
    expect(
      toBrowserCapabilityApiError(new Error("BROWSER_RESOURCE_LIMIT: host slots occupied")),
    ).toMatchObject({
      status: 429,
      code: "browser_resource_limit",
      title: "Browser Resource Limit",
    });
  });

  it("distinguishes a driver bundle authorization failure from backend incapability", () => {
    expect(toBrowserCapabilityApiError(new Error("BROWSER_BUNDLE_UNAVAILABLE"))).toMatchObject({
      status: 503,
      code: "browser_bundle_unavailable",
      title: "Browser Driver Bundle Unavailable",
      message: "The trusted browser driver bundle could not be authorized or loaded.",
    });
  });
});
