// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createQuerySerializer } from "openapi-fetch";
import { QUERY_SERIALIZER } from "../client.ts";

describe("QUERY_SERIALIZER", () => {
  it("sends an array query parameter comma-separated under one key", () => {
    const serialize = createQuerySerializer(QUERY_SERIALIZER);
    expect(serialize({ status: ["failed", "timeout"], limit: 20 })).toBe(
      "status=failed,timeout&limit=20",
    );
  });
});
