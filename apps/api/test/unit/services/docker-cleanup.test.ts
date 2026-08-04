// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { removeTerminalManagedContainers } from "../../../src/services/docker-cleanup.ts";

describe("removeTerminalManagedContainers", () => {
  it("removes only exited and dead containers", async () => {
    const removed: string[] = [];
    const count = await removeTerminalManagedContainers(
      [
        { Id: "running", State: "running" },
        { Id: "restarting", State: "restarting" },
        { Id: "paused", State: "paused" },
        { Id: "created", State: "created" },
        { Id: "exited", State: "exited" },
        { Id: "dead", State: "dead" },
      ],
      async (containerId) => {
        removed.push(containerId);
      },
    );

    expect(removed).toEqual(["exited", "dead"]);
    expect(count).toBe(2);
  });

  it("counts only successful removals", async () => {
    const count = await removeTerminalManagedContainers(
      [
        { Id: "removed", State: "exited" },
        { Id: "failed", State: "dead" },
      ],
      async (containerId) => {
        if (containerId === "failed") throw new Error("Docker refused removal");
      },
    );

    expect(count).toBe(1);
  });
});
