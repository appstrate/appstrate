// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { canKeepBrowserInteractionDegraded } from "../integrations-boot.ts";

describe("browser interaction boot degradation", () => {
  it("keeps only a fully provisioned private driver alive for a human gate", () => {
    expect(
      canKeepBrowserInteractionDegraded({
        errorCode: "BROWSER_INTERACTION_REQUIRED",
        hasPrivateConnect: true,
        browserProvisioned: true,
        driverRegistered: true,
      }),
    ).toBeTrue();

    for (const input of [
      {
        errorCode: "BROWSER_AUTH_REQUIRED",
        hasPrivateConnect: true,
        browserProvisioned: true,
        driverRegistered: true,
      },
      {
        errorCode: "BROWSER_INTERACTION_REQUIRED",
        hasPrivateConnect: false,
        browserProvisioned: true,
        driverRegistered: true,
      },
      {
        errorCode: "BROWSER_INTERACTION_REQUIRED",
        hasPrivateConnect: true,
        browserProvisioned: false,
        driverRegistered: true,
      },
      {
        errorCode: "BROWSER_INTERACTION_REQUIRED",
        hasPrivateConnect: true,
        browserProvisioned: true,
        driverRegistered: false,
      },
    ]) {
      expect(canKeepBrowserInteractionDegraded(input)).toBeFalse();
    }
  });
});
