// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { buildCurlJson, buildCurlMultipart } from "../agent-api-request.ts";

const BASE = {
  packageId: "@acme/worker",
  orgId: "org_a",
  authToken: "apst_secret",
  baseUrl: "https://app.example.test",
};

const SCHEMA: JSONSchemaObject = {
  type: "object",
  properties: {
    topic: { type: "string", default: "news" },
    mode: { type: "string", enum: ["fast", "slow"] },
    count: { type: "integer" },
    dry: { type: "boolean" },
    report: { type: "string", format: "uri", contentMediaType: "application/pdf" },
  },
  required: ["report"],
};

describe("the agent's launch request", () => {
  it("posts a JSON body with a placeholder per non-file field", () => {
    expect(buildCurlJson({ ...BASE, inputSchema: SCHEMA })).toBe(
      [
        'curl -X POST "https://app.example.test/api/agents/@acme/worker/run" \\',
        '  -H "Authorization: Bearer apst_secret" \\',
        '  -H "X-Org-Id: org_a" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '${JSON.stringify(
          { input: { topic: "news", mode: "fast", count: 0, dry: false } },
          null,
          2,
        )}'`,
      ].join("\n"),
    );
  });

  it("posts an empty object for an agent without parameters", () => {
    expect(buildCurlJson(BASE).endsWith(`  -d '{}'`)).toBe(true);
  });

  it("sends the input as one part and each file as its own, with no trailing continuation", () => {
    expect(buildCurlMultipart({ ...BASE, inputSchema: SCHEMA })).toBe(
      [
        'curl -X POST "https://app.example.test/api/agents/@acme/worker/run" \\',
        '  -H "Authorization: Bearer apst_secret" \\',
        '  -H "X-Org-Id: org_a" \\',
        `  -F 'input={"topic":"news","mode":"fast","count":0,"dry":false}' \\`,
        "  -F 'report=@/path/to/report.pdf'",
      ].join("\n"),
    );
  });
});
