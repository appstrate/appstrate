// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import {
  closeAllClients,
  handleClientFrame,
  registerClient,
  sendCommand,
  unregisterClient,
  DesktopNotConnectedError,
} from "../../registry.ts";

afterEach(() => closeAllClients());

describe("desktop registry pending commands", () => {
  it("rejects immediately when the owning socket disconnects", async () => {
    const client = {
      userId: "u1",
      send(): void {},
      close(): void {},
    };
    registerClient(client);
    const pending = sendCommand("u1", "browser.screenshot", {}, { timeoutMs: 10_000 });
    unregisterClient("u1", client);
    await expect(pending).rejects.toBeInstanceOf(DesktopNotConnectedError);
  });

  it("does not let another user resolve a correlated reply", async () => {
    let requestId = "";
    registerClient({
      userId: "u1",
      send(payload): void {
        requestId = (JSON.parse(payload) as { id: string }).id;
      },
      close(): void {},
    });
    const pending = sendCommand("u1", "browser.screenshot", {});
    handleClientFrame("u2", { id: requestId, result: "foreign" });
    handleClientFrame("u1", { id: requestId, result: "owned" });
    await expect(pending).resolves.toBe("owned");
  });
});
