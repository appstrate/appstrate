// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `resolveLocalInput` — layers 1-2 a LOCAL `appstrate run`
 * applies underneath the caller's `--input` / `--input-file`.
 *
 * The platform resolves `manifest.input.schema` defaults and the
 * per-application stored values on every run, so a local run of the same
 * agent must resolve them too or it executes with different parameters than
 * the dashboard would. Layers 3-4 (schedule values, caller input on a
 * platform run) deliberately have no equivalent: the server owns that chain.
 */

import { describe, it, expect } from "bun:test";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import { resolveLocalInput, LockedInputFieldError } from "../src/commands/run.ts";

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

/**
 * Layer 2 — `application_packages.input_settings`, delivered by the
 * `run-config` endpoint. Present only for `appstrate run @scope/agent`
 * (a REMOTE package installed in an application); a bundle read off disk
 * has no application row behind it and passes `undefined`.
 */
describe("resolveLocalInput — stored input layer (remote package)", () => {
  const STORED = { values: { tone: "brisk" }, lockedFields: [] as string[] };

  it("inherits the editor's stored value over the author default", () => {
    expect(resolveLocalInput(TONE_BUNDLE, {}, STORED)).toEqual({ tone: "brisk" });
  });

  it("lets the caller's input beat the stored value", () => {
    expect(resolveLocalInput(TONE_BUNDLE, { tone: "formal" }, STORED)).toEqual({ tone: "formal" });
  });

  it("keeps the author default for a property the editor did not store", () => {
    const bundle = makeBundle({
      schema: {
        type: "object",
        properties: {
          tone: { type: "string", default: "neutral" },
          dry_run: { type: "boolean", default: false },
        },
      },
    });
    expect(resolveLocalInput(bundle, {}, STORED)).toEqual({ tone: "brisk", dry_run: false });
  });

  it("applies stored values even when the agent declares no input schema", () => {
    expect(resolveLocalInput(makeBundle(undefined), {}, STORED)).toEqual({ tone: "brisk" });
  });

  it("refuses a caller value naming a locked field, naming the field", () => {
    const stored = { values: { dry_run: true }, lockedFields: ["dry_run"] };
    const bundle = makeBundle({
      schema: { type: "object", properties: { dry_run: { type: "boolean" } } },
    });
    expect(() => resolveLocalInput(bundle, { dry_run: false }, stored)).toThrow(
      LockedInputFieldError,
    );
    try {
      resolveLocalInput(bundle, { dry_run: false }, stored);
      throw new Error("expected a LockedInputFieldError");
    } catch (err) {
      expect(err).toBeInstanceOf(LockedInputFieldError);
      expect((err as LockedInputFieldError).field).toBe("dry_run");
      expect((err as Error).message).toContain("dry_run");
    }
  });

  it("applies the locked field's stored value when the caller leaves it alone", () => {
    const stored = { values: { dry_run: true }, lockedFields: ["dry_run"] };
    const bundle = makeBundle({
      schema: {
        type: "object",
        properties: { dry_run: { type: "boolean", default: false }, tone: { type: "string" } },
      },
    });
    expect(resolveLocalInput(bundle, { tone: "formal" }, stored)).toEqual({
      dry_run: true,
      tone: "formal",
    });
  });

  it("leaves a local bundle path (no stored layer) on author defaults only", () => {
    // `appstrate run ./dir` has no application row — nothing is inherited and
    // no lock can apply, so the pre-existing behaviour is unchanged.
    expect(resolveLocalInput(TONE_BUNDLE, { extra: 1 }, undefined)).toEqual({
      tone: "neutral",
      extra: 1,
    });
  });
});
