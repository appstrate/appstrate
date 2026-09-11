// SPDX-License-Identifier: Apache-2.0

/**
 * A 400 for an unknown body key must name THAT key — never a field the request
 * got right.
 *
 * Zod 4 reports `unrecognized_keys` with an EMPTY `path` (the offending names
 * live in `issue.keys`), so `zodIssuesToFieldErrors` used to fall through to
 * the caller-supplied `param`. Two routes supply one — `PUT /api/agents/
 * {scope}/{name}/skills` (`param: "skillIds"`) and `POST /api/packages/
 * import-github` (`param: "url"`) — so a body carrying a typo'd extra key
 * answered `errors[0].field = "skillIds"` / `"url"`, blaming the one field the
 * client had spelled correctly.
 *
 * The `param` fallback is still right for the issue shapes it was written for
 * (a root-level type/format failure genuinely has no path), so the control
 * below pins that half unchanged.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { zodIssuesToFieldErrors, parseBody, ApiError } from "@appstrate/core/api-errors";
import { updateSkillsSchema } from "../../src/routes/user-agents.ts";
import { githubImportSchema } from "../../src/routes/packages.ts";

/** Run a schema + param exactly as the route's `readJsonBody` call does. */
function refusal(schema: z.ZodType, body: unknown, param: string) {
  try {
    parseBody(schema, body, param);
  } catch (err) {
    if (err instanceof ApiError) {
      const problem = err.toProblemDetail("req_test");
      return { ...problem, errors: problem.errors ?? [] };
    }
    throw err;
  }
  throw new Error("expected the body to be refused");
}

describe("unknown body keys are named by the key, not by the route's param", () => {
  it("PUT /api/agents/{scope}/{name}/skills — names `extra`, not `skillIds`", () => {
    const body = refusal(updateSkillsSchema, { skillIds: ["@a/b"], extra: 1 }, "skillIds");

    expect(body.code).toBe("validation_failed");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.field).toBe("extra");
    expect(body.errors[0]!.code).toBe("unknown_field");
    expect(body.detail).toStartWith("extra: ");
  });

  it("POST /api/packages/import-github — names `branch`, not `url`", () => {
    const body = refusal(
      githubImportSchema,
      { url: "https://github.com/acme/repo", branch: "main" },
      "url",
    );

    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.field).toBe("branch");
    expect(body.errors[0]!.code).toBe("unknown_field");
  });

  it("every unrecognized key gets its own entry", () => {
    const body = refusal(updateSkillsSchema, { skillIds: [], extra: 1, other: 2 }, "skillIds");

    expect(body.errors.map((e) => e.field)).toEqual(["extra", "other"]);
    expect(body.errors.every((e) => e.code === "unknown_field")).toBe(true);
    // Each entry names only its own key — not the combined Zod message.
    expect(body.errors[0]!.message).toBe('Unrecognized key: "extra"');
    expect(body.errors[1]!.message).toBe('Unrecognized key: "other"');
  });

  it("a nested unknown key keeps its container path", () => {
    const schema = z.strictObject({ nested: z.strictObject({ a: z.string() }) });
    const errors = zodIssuesToFieldErrors(
      schema.safeParse({ nested: { a: "x", bad: 1 } }).error!.issues,
      "nested",
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("nested.bad");
  });

  // CONTROL — the `param` fallback still applies to the issue shapes it was
  // meant for: a root-level failure with a genuinely empty path.
  it("the `param` fallback still names the route field on a root-level failure", () => {
    const body = refusal(updateSkillsSchema, "not-an-object", "skillIds");

    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.field).toBe("skillIds");
    expect(body.errors[0]!.code).toBe("invalid_type");
  });

  // CONTROL — a keyed issue that is NOT `unrecognized_keys` still reports its
  // own path, so the change is scoped to the one issue code.
  it("a wrong-typed known field is unaffected", () => {
    const body = refusal(updateSkillsSchema, { skillIds: "nope" }, "skillIds");

    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.field).toBe("skillIds");
    expect(body.errors[0]!.code).toBe("invalid_type");
  });
});
