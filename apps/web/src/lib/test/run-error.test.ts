// SPDX-License-Identifier: Apache-2.0

/**
 * A run keeps whatever ended it verbatim; `runErrorText` says it in the
 * reader's language. Two stored forms are recognised: the platform's own
 * cancellation line, and a model provider's refusal stored as
 * `<status> <JSON body>`. Anything else is shown as written.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { TFunction } from "i18next";
import { runErrorText, runErrorTone } from "../run-error.ts";

/** Echoes the key and its values, so the test reads which sentence was chosen. */
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as TFunction;

const failed = (error: string | null) => runErrorText({ status: "failed", error }, t);

describe("runErrorText", () => {
  it("words the cancellation the API writes, and only on a cancelled run", async () => {
    // The same literal the cancel route stores (`routes/runs.ts`).
    const route = await Bun.file(
      join(import.meta.dir, "../../../../api/src/routes/runs.ts"),
    ).text();
    expect(route).toContain('error: { message: "Cancelled by user" }');

    expect(runErrorText({ status: "cancelled", error: "Cancelled by user" }, t)).toBe(
      "run.cancelledByUser",
    );
    expect(failed("Cancelled by user")).toBe("Cancelled by user");
  });

  it("names an authentication or rate-limit refusal by its status", () => {
    expect(failed('401 {"error":{"message":"invalid x-api-key"}}')).toBe("run.error.modelRefused");
    expect(failed('403 {"error":{"message":"forbidden"}}')).toBe("run.error.modelRefused");
    expect(failed('429 {"error":{"message":"slow down"}}')).toBe("run.error.modelRateLimited");
  });

  it("carries a provider's message, from either JSON shape, with its status", () => {
    expect(failed('400 {"error":{"message":"  prompt is too long  "}}')).toBe(
      'run.error.model {"status":400,"message":"prompt is too long"}',
    );
    expect(failed('500 {"message":"overloaded"}')).toBe(
      'run.error.model {"status":500,"message":"overloaded"}',
    );
  });

  it("shows the stored text when the body names no message or is not JSON", () => {
    expect(failed('400 {"error":{"code":"x"}}')).toBe('400 {"error":{"code":"x"}}');
    expect(failed("400 {not json}")).toBe("400 {not json}");
    expect(failed("Container exited with code 1")).toBe("Container exited with code 1");
    expect(failed(null)).toBe("");
  });
});

describe("runErrorTone", () => {
  it("mutes a cancelled run's error and reds every other", () => {
    expect(runErrorTone({ status: "cancelled" })).toBe("text-muted-foreground");
    expect(runErrorTone({ status: "failed" })).toBe("text-destructive");
    expect(runErrorTone({ status: "timeout" })).toBe("text-destructive");
  });
});
