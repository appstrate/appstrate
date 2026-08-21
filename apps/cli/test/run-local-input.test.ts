// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `resolveLocalInput` — the author-default layer a LOCAL
 * `appstrate run` applies underneath the caller's `--input` / `--input-file`.
 *
 * The platform resolves `manifest.input.schema` defaults on every run, so a
 * local run of the same bundle must resolve them too or it executes with
 * different parameters than the dashboard would. The remote path
 * deliberately has no equivalent: the server owns that chain.
 */

import { describe, it, expect } from "bun:test";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import { resolveLocalInput } from "../src/commands/run.ts";

/**
 * Minimal Bundle fixture — `resolveLocalInput` only reads the root
 * package's `manifest.input.schema`. Same shortcut as
 * `run-report-source.test.ts`; the rest of the Bundle shape is irrelevant.
 */
function makeBundle(input?: unknown): Bundle {
  const root = "@scope/agent@1.0.0";
  const manifest: Record<string, unknown> = {
    name: "@scope/agent",
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    ...(input !== undefined ? { input } : {}),
  };
  return {
    version: "1.0",
    root,
    integrity: "sha256-test",
    packages: new Map([[root, { identity: root, manifest, files: new Map(), integrity: "" }]]),
  } as unknown as Bundle;
}

const TONE_BUNDLE = makeBundle({
  schema: { type: "object", properties: { tone: { type: "string", default: "neutral" } } },
});

describe("resolveLocalInput", () => {
  it("applies the author default when the caller supplied nothing", () => {
    expect(resolveLocalInput(TONE_BUNDLE, {})).toEqual({ tone: "neutral" });
  });

  it("lets the caller's value win over the author default", () => {
    expect(resolveLocalInput(TONE_BUNDLE, { tone: "formal" })).toEqual({ tone: "formal" });
  });

  it("lets an explicit null / empty string from the caller win", () => {
    expect(resolveLocalInput(TONE_BUNDLE, { tone: null })).toEqual({ tone: null });
    expect(resolveLocalInput(TONE_BUNDLE, { tone: "" })).toEqual({ tone: "" });
  });

  it("keeps caller keys the schema does not declare", () => {
    expect(resolveLocalInput(TONE_BUNDLE, { extra: 1 })).toEqual({ tone: "neutral", extra: 1 });
  });

  it("returns the caller input unchanged when the agent declares no input schema", () => {
    const bundle = makeBundle(undefined);
    expect(resolveLocalInput(bundle, { topic: "weekly" })).toEqual({ topic: "weekly" });
  });

  it("returns the caller input unchanged when `input` carries no schema", () => {
    const bundle = makeBundle({ ui_hints: {} });
    expect(resolveLocalInput(bundle, { topic: "weekly" })).toEqual({ topic: "weekly" });
  });

  // Platform parity: a declared property with no `default` stays ABSENT, it
  // is not materialised as `null`. The platform's `resolveEffectiveInput`
  // does the same, so the same bundle run locally and on a platform receives
  // the same parameters — and the bundle's own `required` check sees a
  // missing value as missing.
  it("leaves a declared property that has no default absent", () => {
    const bundle = makeBundle({
      schema: {
        type: "object",
        properties: { tone: { type: "string", default: "neutral" }, urgency: { type: "string" } },
      },
    });
    expect(resolveLocalInput(bundle, {})).toEqual({ tone: "neutral" });
  });
});
