// SPDX-License-Identifier: Apache-2.0

/**
 * Public field-error codes derived from Zod issues (#1790): a missing field
 * reports `required`, a present-but-wrong one `invalid_type`.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ApiError, parseBody, zodIssuesToFieldErrors } from "../src/api-errors.ts";

const schema = z.object({
  name: z.string(),
  nick: z.string().optional(),
  profile: z.object({ email: z.string() }),
  items: z.array(z.object({ id: z.string() })),
});

const profile = { email: "a@b.c" };
const items = [{ id: "1" }];

function fieldErrorsOf(body: unknown, param?: string) {
  try {
    parseBody(schema, body, param);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return (err as ApiError).fieldErrors?.map(({ field, code }) => ({ field, code }));
  }
  throw new Error("parseBody accepted the body");
}

describe("parseBody field-error codes", () => {
  it.each([
    ["a missing field", { profile, items }, "name", "required"],
    ["a wrong-typed field", { name: 42, profile, items }, "name", "invalid_type"],
    ["null for a non-nullable field", { name: null, profile, items }, "name", "invalid_type"],
    ["a missing nested field", { name: "a", profile: {}, items }, "profile.email", "required"],
    ["a missing nested object", { name: "a", items }, "profile", "required"],
    [
      "a missing array element field",
      { name: "a", profile, items: [{}] },
      "items[0].id",
      "required",
    ],
  ])("reports %s", (_label, body, field, code) => {
    expect(fieldErrorsOf(body)).toEqual([{ field, code }]);
  });

  it("accepts an absent optional field", () => {
    expect(parseBody(schema, { name: "a", profile, items })).toEqual({ name: "a", profile, items });
  });

  it("reports missing and wrong-typed fields together, each with its own code", () => {
    expect(fieldErrorsOf({ profile: { email: 1 }, items })).toEqual([
      { field: "name", code: "required" },
      { field: "profile.email", code: "invalid_type" },
    ]);
  });

  it("reports a missing body as required on the param fallback", () => {
    expect(fieldErrorsOf(undefined, "payload")).toEqual([{ field: "payload", code: "required" }]);
  });
});

describe("zodIssuesToFieldErrors without reportInput", () => {
  // Regression witness: Zod 4 omits `input` from issues unless `reportInput`
  // is set, so a missing field must stay `invalid_type` here — never a false
  // `required`. If Zod starts always reporting `input`, this test says so.
  it("reports a missing field as invalid_type", () => {
    const result = schema.safeParse({ profile, items });
    if (result.success) throw new Error("schema accepted the body");
    expect(
      zodIssuesToFieldErrors(result.error.issues).map(({ field, code }) => ({ field, code })),
    ).toEqual([{ field: "name", code: "invalid_type" }]);
  });
});
