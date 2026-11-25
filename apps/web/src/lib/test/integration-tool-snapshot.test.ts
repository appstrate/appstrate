// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { snapshotRefreshBlock, toolSnapshotInfo } from "../integration-tool-snapshot.ts";

const detail = (source: unknown) => ({
  active: true,
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

describe("snapshotRefreshBlock", () => {
  const ok = {
    remote: true,
    published: true,
    active: true,
    unauthenticated: false,
    hasConnection: true,
  };

  it("offers nothing for a source that cannot be listed", () => {
    expect(snapshotRefreshBlock({ ...ok, remote: false }, true)).toBeNull();
  });

  it("names the first reason the refresh would be refused", () => {
    expect(snapshotRefreshBlock(ok, true)).toBeNull();
    expect(snapshotRefreshBlock({ ...ok, published: false, active: false }, true)).toBe(
      "unpublished",
    );
    expect(snapshotRefreshBlock({ ...ok, active: false }, true)).toBe("inactive");
    expect(snapshotRefreshBlock(ok, false)).toBe("no_permission");
    expect(snapshotRefreshBlock({ ...ok, hasConnection: false }, true)).toBe("no_connection");
  });

  it("reads an unauthenticated server without a connection nor the proxy permission", () => {
    expect(
      snapshotRefreshBlock({ ...ok, unauthenticated: true, hasConnection: false }, false),
    ).toBeNull();
  });
});
