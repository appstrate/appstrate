// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { toolSnapshotInfo } from "../integration-tool-snapshot.ts";

const detail = (source: unknown) => ({
  tool_snapshot: null,
  manifest: { source },
  auths: [],
});
const remote = (transport: string) => ({
  kind: "remote",
  remote: { url: "https://mcp.acme.test", transport },
});

describe("toolSnapshotInfo", () => {
  it("offers the listing of a Streamable HTTP remote server only", () => {
    expect(toolSnapshotInfo("@a/b", detail(remote("streamable-http")), true).remote).toBe(true);
    expect(toolSnapshotInfo("@a/b", detail(remote("sse")), true).remote).toBe(false);
    expect(toolSnapshotInfo("@a/b", detail({ kind: "none" }), true).remote).toBe(false);
    expect(toolSnapshotInfo("@a/b", detail(undefined), true).remote).toBe(false);
  });

  it("carries whether a version is published, the one the listing is read from", () => {
    expect(toolSnapshotInfo("@a/b", detail(remote("streamable-http")), false).published).toBe(
      false,
    );
  });
});
