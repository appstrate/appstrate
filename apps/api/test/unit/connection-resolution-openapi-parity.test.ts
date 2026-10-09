// SPDX-License-Identifier: Apache-2.0

/**
 * PARITY: the published connection-resolution components vs the core code tuples they are built
 * from — a launch `warnings[]` item, a `409 missing_integration_connection` item, and the
 * run-admission 409 that carries either problem.
 */

import { describe, expect, it } from "bun:test";
import Ajv from "ajv";
import {
  CONNECTION_RESOLUTION_ERROR_CODES,
  CONNECTION_RESOLUTION_WARNING_CODES,
  INTEGRATION_MANIFEST_FAILURE_CODES,
  MISSING_INTEGRATION_CONNECTION_CODES,
} from "@appstrate/core/integration";
import { buildOpenApiSpec } from "../../src/openapi/index.ts";
import { createOpenApiValidator } from "../helpers/openapi-validator.ts";

const spec = buildOpenApiSpec();
const { dereference } = createOpenApiValidator(spec);
const ajv = new Ajv({ strict: false, validateFormats: false });
const compile = (schema: unknown) => ajv.compile(dereference(schema) as object);
const component = (name: string) => compile({ $ref: `#/components/schemas/${name}` });

const item = (code: string) => ({ field: "integrations.@acme/gmail", code, message: "m" });

describe("connection-resolution components ↔ core tuples", () => {
  it("a launch warning takes exactly the warning codes", () => {
    const validate = component("ConnectionResolutionWarning");
    for (const code of CONNECTION_RESOLUTION_WARNING_CODES) expect(validate(item(code))).toBe(true);
    expect(validate(item("needs_reconnection"))).toBe(false);
  });

  it("a 409 item takes the resolution, manifest-failure and remote-runner codes, and no other", () => {
    const validate = component("ConnectionResolutionItem");
    expect(MISSING_INTEGRATION_CONNECTION_CODES).toEqual([
      ...CONNECTION_RESOLUTION_ERROR_CODES,
      ...INTEGRATION_MANIFEST_FAILURE_CODES,
      "remote_binds_one_connection",
    ]);
    for (const code of MISSING_INTEGRATION_CONNECTION_CODES)
      expect(validate(item(code))).toBe(true);
    expect(validate(item("integration_unbound"))).toBe(false);
  });

  it("the run-admission 409 carries any problem, typed only when it is missing_integration_connection", () => {
    const { responses } = (
      spec as unknown as {
        components: { responses: Record<string, { content: Record<string, { schema: unknown }> }> };
      }
    ).components;
    const response = responses.RunAdmissionConflict!;
    const validate = compile(response.content["application/problem+json"]!.schema);
    const problem = {
      type: "https://docs.appstrate.dev/errors/x",
      title: "T",
      status: 409,
      detail: "d",
      request_id: "req_1",
    };
    expect(validate({ ...problem, code: "idempotency_in_progress" })).toBe(true);
    const missing = { ...problem, code: "missing_integration_connection" };
    expect(validate({ ...missing, errors: [item("must_choose_connection")] })).toBe(true);
    // `anyOf`: the plain ProblemDetail branch still admits an untyped code, so the typed branch
    // is asserted on its own.
    const typed = component("MissingIntegrationConnectionProblem");
    expect(typed({ ...missing, errors: [item("must_choose_connection")] })).toBe(true);
    expect(typed({ ...missing, errors: [item("integration_unbound")] })).toBe(false);
    expect(typed({ ...missing })).toBe(false);
  });
});
