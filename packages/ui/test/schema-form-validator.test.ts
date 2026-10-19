// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { RJSFSchema } from "@rjsf/utils";
import { validateAgainstSchema } from "@appstrate/core/schema-validation";
import { schemaFormValidator } from "../src/schema-form/validator.ts";

function verdicts(schema: object, data: Record<string, unknown>) {
  return {
    client: schemaFormValidator.isValid(schema as RJSFSchema, data, data),
    server: validateAgainstSchema(data, schema as never).valid,
  };
}

const bounded = {
  type: "object",
  properties: { start: { type: "string", format: "date", formatMinimum: "2026-01-01" } },
};
const plain = {
  type: "object",
  properties: { start: { type: "string", format: "date" } },
};

describe("schemaFormValidator parity with the server-side Ajv", () => {
  // `formatMinimum` is not JSON Schema 2020-12: neither side enforces it, neither throws.
  for (const start of ["2025-12-31", "2026-01-01", "2026-01-02"]) {
    it(`agrees on a date ${start} under formatMinimum`, () => {
      const { client, server } = verdicts(bounded, { start });
      expect(client).toBe(server);
    });
  }

  for (const [start, accepted] of [
    ["2026-09-01", true],
    ["2026-02-30", false],
    ["not-a-date", false],
  ] as const) {
    it(`still enforces format "date" on ${start}`, () => {
      expect(verdicts(plain, { start })).toEqual({ client: accepted, server: accepted });
      expect(verdicts(bounded, { start })).toEqual({ client: accepted, server: accepted });
    });
  }
});
