// SPDX-License-Identifier: Apache-2.0

/**
 * Public field-error codes derived from Zod issues (#1790): a missing field
 * reports `required`, a present-but-wrong one keeps its own code.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ApiError, parseBody, zodIssuesToFieldErrors } from "../src/api-errors.ts";

const schema = z.object({
  name: z.string(),
  nick: z.string().optional(),
  profile: z.object({ email: z.string() }),
  items: z.array(z.object({ id: z.string() })),
  role: z.enum(["admin", "member"]),
  kind: z.literal("user"),
  ref: z.union([z.string(), z.number()]),
});

const valid = {
  name: "a",
  profile: { email: "a@b.c" },
  items: [{ id: "1" }],
  role: "admin",
  kind: "user",
  ref: 1,
} satisfies z.input<typeof schema>;

/** `valid` without `key` — the key is absent, not set to `undefined`. */
function omit(key: keyof typeof valid) {
  return Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));
}

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
    ["a missing field", omit("name"), "name", "required"],
    ["a wrong-typed field", { ...valid, name: 42 }, "name", "invalid_type"],
    ["null for a non-nullable field", { ...valid, name: null }, "name", "invalid_type"],
    ["a missing nested field", { ...valid, profile: {} }, "profile.email", "required"],
    ["a missing nested object", omit("profile"), "profile", "required"],
    ["a missing array element field", { ...valid, items: [{}] }, "items[0].id", "required"],
    ["a missing enum field", omit("role"), "role", "required"],
    ["a missing literal field", omit("kind"), "kind", "required"],
    ["a missing union field", omit("ref"), "ref", "required"],
    ["a wrong enum value", { ...valid, role: "owner" }, "role", "invalid_value"],
    ["a wrong-typed union value", { ...valid, ref: true }, "ref", "invalid_union"],
  ])("reports %s", (_label, body, field, code) => {
    expect(fieldErrorsOf(body)).toEqual([{ field, code }]);
  });

  it("accepts an absent optional field", () => {
    expect(parseBody(schema, valid)).toEqual(valid);
  });

  it("reports missing and wrong-typed fields together, each with its own code", () => {
    expect(fieldErrorsOf({ ...omit("name"), profile: { email: 1 } })).toEqual([
      { field: "name", code: "required" },
      { field: "profile.email", code: "invalid_type" },
    ]);
  });

  it("reports a missing body as required on the param fallback", () => {
    expect(fieldErrorsOf(undefined, "payload")).toEqual([{ field: "payload", code: "required" }]);
  });
});

describe("zodIssuesToFieldErrors without reportInput", () => {
  // Canary: pins that Zod strips `input` from issues unless `reportInput` is
  // set. If Zod starts always reporting `input`, this fails and `parseBody`
  // can drop `reportInput`.
  it("reports a missing field with its Zod-derived code", () => {
    const result = schema.safeParse(omit("name"));
    if (result.success) throw new Error("schema accepted the body");
    expect(
      zodIssuesToFieldErrors(result.error.issues).map(({ field, code }) => ({ field, code })),
    ).toEqual([{ field: "name", code: "invalid_type" }]);
  });
});
