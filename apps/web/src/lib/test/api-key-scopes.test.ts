// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { apiKeyScopesBody } from "../api-key-scopes.ts";

const AVAILABLE = ["agents:read", "agents:run", "runs:read"];

describe("apiKeyScopesBody", () => {
  it("sends the picks, so a partial selection is never widened", () => {
    expect(apiKeyScopesBody(["agents:read"], AVAILABLE)).toEqual(["agents:read"]);
    expect(apiKeyScopesBody([], AVAILABLE)).toEqual([]);
    // Nothing loaded yet is not "everything picked".
    expect(apiKeyScopesBody([], [])).toEqual([]);
  });

  it("omits the member only when every available scope was picked", () => {
    expect(apiKeyScopesBody([...AVAILABLE].reverse(), AVAILABLE)).toBeUndefined();
    // Same count, different set: not "everything".
    expect(apiKeyScopesBody(["agents:read", "agents:run", "stale:scope"], AVAILABLE)).toEqual([
      "agents:read",
      "agents:run",
      "stale:scope",
    ]);
  });
});
