// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { SIDECAR_SIGTERM_GRACE_SECONDS } from "@appstrate/core/sidecar-types";

// The guest supervisor starts `main()` on import and is bundled without core, so its literal is
// read from the source rather than imported.
describe("guest supervisor sidecar stop grace", () => {
  it("outlasts the sidecar's SIGTERM grace so a landing journal drain is not cut short", async () => {
    const source = await Bun.file(
      new URL("../../../../src/modules/firecracker/guest/supervisor.ts", import.meta.url),
    ).text();
    const match = /const SIDECAR_STOP_GRACE_MS = ([\d_]+);/.exec(source);
    expect(match).not.toBeNull();
    const graceMs = Number(match![1]!.replaceAll("_", ""));
    expect(graceMs).toBeGreaterThan(SIDECAR_SIGTERM_GRACE_SECONDS * 1000);
  });
});
