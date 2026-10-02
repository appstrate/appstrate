// SPDX-License-Identifier: Apache-2.0

/**
 * §6b of `bun run verify:openapi`: every error response declares a ProblemDetail body.
 * The gate builds its document from the real source tree, so the failing paths are
 * exercised here against hand-built documents.
 */

import { describe, it, expect } from "bun:test";
import { checkErrorResponseBodies } from "../lib/openapi-error-responses.ts";

const PROBLEM = {
  "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
};

function specWith(responses: Record<string, unknown>): unknown {
  return {
    paths: { "/x": { get: { responses: { "200": { description: "ok" }, ...responses } } } },
    components: {
      schemas: { ProblemDetail: { type: "object" } },
      responses: { NotFound: { description: "gone", content: PROBLEM } },
    },
  };
}

describe("checkErrorResponseBodies", () => {
  it("accepts inline ProblemDetail, a shared-response $ref and an allOf extension", () => {
    const report = checkErrorResponseBodies(
      specWith({
        "400": { description: "bad", content: PROBLEM },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "conflict",
          content: {
            "application/problem+json": {
              schema: {
                allOf: [{ $ref: "#/components/schemas/ProblemDetail" }, { type: "object" }],
              },
            },
            "application/json": { schema: { type: "object" } },
          },
        },
      }),
      {},
    );
    expect(report).toEqual({ checked: 3, gaps: [], stale: [] });
  });

  it("flags a 4xx, a 5xx and a default response that declare no ProblemDetail body", () => {
    const report = checkErrorResponseBodies(
      specWith({
        "401": { description: "no body" },
        "502": { description: "json", content: { "application/json": { schema: {} } } },
        default: {
          description: "wrong schema",
          content: { "application/problem+json": { schema: { type: "object" } } },
        },
      }),
      {},
    );
    expect(report.gaps).toEqual([
      "GET /x 401 — declares no body",
      "GET /x 502 — declares application/json",
      "GET /x default — application/problem+json schema is not ProblemDetail",
    ]);
  });

  it("flags a $ref that resolves to nothing", () => {
    const report = checkErrorResponseBodies(
      specWith({ "404": { $ref: "#/components/responses/Absent" } }),
      {},
    );
    expect(report.gaps).toEqual(["GET /x 404 — unresolvable $ref #/components/responses/Absent"]);
  });

  it("accepts an exempted response only when it declares the exempted media type", () => {
    const html = { "text/html": { schema: { type: "string" } } };
    const report = checkErrorResponseBodies(
      specWith({
        "400": { description: "page", content: html },
        "403": { description: "bare page" },
        "429": { description: "limited", content: PROBLEM },
      }),
      { "GET /x": "text/html" },
    );
    expect(report.gaps).toEqual(["GET /x 403 — declares no body (exempted as text/html)"]);
    expect(report.stale).toEqual([]);
  });

  it("prefers a status-level exemption and reports every exemption that excused nothing", () => {
    const report = checkErrorResponseBodies(
      specWith({
        "503": { description: "report", content: { "application/json": { schema: {} } } },
        "500": { description: "err", content: PROBLEM },
      }),
      { "GET /x 503": "application/json", "GET /x 500": "text/plain", "GET /gone": "text/html" },
    );
    expect(report.gaps).toEqual([]);
    expect(report.stale).toEqual(["GET /gone", "GET /x 500"]);
  });
});
