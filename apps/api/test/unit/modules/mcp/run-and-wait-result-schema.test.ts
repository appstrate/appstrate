// SPDX-License-Identifier: Apache-2.0

// What core projects for `run_and_wait` is what the `RunAndWaitResult` component
// (the tool's `outputSchema`) accepts, checked with the validator the SDK client
// applies to `structuredContent`.

import { describe, expect, it } from "bun:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { runAndWaitStepsWithFiles } from "@appstrate/core/run-and-wait-client";
import { getRunAndWaitOutputSchema } from "../../../../src/modules/mcp/catalog.ts";
import { registerTestPlatformApp } from "../../../helpers/platform-app.ts";

await registerTestPlatformApp();

const validate = new AjvJsonSchemaValidator().getValidator(
  getRunAndWaitOutputSchema() as JsonSchemaType,
);

const warning = {
  field: "integrations.@appstrate/gmail",
  code: "not_connected",
  message: "Gmail is not connected",
  auth_key: "oauth",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** The payloads core yields for one launch, given what the poll and the file list answer. */
async function payloads(
  run: Record<string, unknown>,
  opts: { files?: unknown[]; maxMs?: number } = {},
): Promise<Record<string, unknown>[]> {
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith("/run")) {
      return jsonResponse({
        id: "run_1",
        packageId: "@acme/writer",
        status: "pending",
        warnings: [warning],
      });
    }
    if (url.includes("/api/files")) {
      return jsonResponse({ object: "list", data: opts.files ?? [], hasMore: false });
    }
    return jsonResponse({ id: "run_1", packageId: "@acme/writer", ...run });
  }) as typeof fetch;
  const out: Record<string, unknown>[] = [];
  for await (const step of runAndWaitStepsWithFiles(
    { kind: "agent", scope: "@acme", name: "writer" },
    { origin: "https://test.local", headers: {}, fetch: fetchImpl, maxMs: opts.maxMs },
  )) {
    out.push(step.payload);
  }
  return out;
}

function expectValid(payload: Record<string, unknown>): void {
  const verdict = validate(payload);
  expect(verdict.errorMessage).toBeUndefined();
  expect(verdict.valid).toBe(true);
}

describe("RunAndWaitResult ↔ core's run_and_wait projection", () => {
  it("accepts a run still going, and a finished one with its files and warnings", async () => {
    const file = {
      id: "file_1",
      uri: "appfile://file_1",
      name: "report.md",
      mime: "text/markdown",
      size: 12,
      purpose: "agent_output",
      runId: "run_1",
    };
    const steps = await payloads(
      { status: "success", result: { summary: "ok" } },
      { files: [file] },
    );
    expect(steps.map((p) => p.done)).toEqual([false, true]);
    expect(steps[1]).toHaveProperty("files");
    steps.forEach(expectValid);
  });

  it("accepts a failed run's error and a truncated result", async () => {
    const [, failed] = await payloads({ status: "failed", error: "Gmail token expired" });
    expectValid(failed!);
    const [, truncated] = await payloads({ status: "success", result: "x".repeat(40_000) });
    expect(truncated).toHaveProperty("truncated", true);
    expectValid(truncated!);
  });

  it("accepts the payload of a wait that ended first", async () => {
    const [, waited] = await payloads({ status: "running" }, { maxMs: 0 });
    expect(waited).toMatchObject({ done: false, warnings: [warning] });
    expectValid(waited!);
  });

  it("refuses an outcome on a run still going, and any undeclared key", () => {
    const going = { id: "run_1", packageId: null, status: "running", done: false, warnings: [] };
    expect(validate({ ...going, error: "still running" }).valid).toBe(false);
    expect(validate({ ...going, result: {} }).valid).toBe(false);
    expect(validate({ ...going, elapsed_ms: 1 }).valid).toBe(false);
    expect(validate({ ...going, warnings: undefined }).valid).toBe(false);
  });
});
