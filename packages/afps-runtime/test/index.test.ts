// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { VERSION, afpsEventSchema, executionContextSchema, AUTH_KINDS } from "../src/index.ts";

describe("public surface", () => {
  it("exports VERSION matching package.json", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("exports the AfpsEvent Zod schema", () => {
    expect(afpsEventSchema).toBeDefined();
    expect(typeof afpsEventSchema.safeParse).toBe("function");
  });

  it("exports the ExecutionContext Zod schema", () => {
    expect(executionContextSchema).toBeDefined();
    expect(typeof executionContextSchema.safeParse).toBe("function");
  });

  it("exports AUTH_KINDS as a const tuple with the expected members", () => {
    expect(AUTH_KINDS).toEqual([
      "api_key",
      "oauth2_client_creds",
      "oauth2_device_code",
      "oauth2_pkce_server",
      "pat",
    ]);
  });
});
