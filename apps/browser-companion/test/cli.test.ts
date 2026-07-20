// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { waitForLocalLogin } from "../src/cli.ts";

function pending<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

describe("local companion lifecycle", () => {
  it("continues when the user confirms the login", async () => {
    await expect(
      waitForLocalLogin({
        completed: Promise.resolve(),
        chromeExited: pending<number>(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it("stops when the user closes Chrome before confirming", async () => {
    await expect(
      waitForLocalLogin({
        completed: pending<void>(),
        chromeExited: Promise.resolve(0),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toThrow("Chrome was closed before the login was confirmed");
  });

  it("does not outlive the server-side attempt", async () => {
    await expect(
      waitForLocalLogin({
        completed: pending<void>(),
        chromeExited: pending<number>(),
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }),
    ).rejects.toThrow("Companion attempt expired");
  });
});
