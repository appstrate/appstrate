// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the local input pipeline: `resolveLocalInput` — layers 1-2 a
 * LOCAL `appstrate run` applies underneath the caller's `--input` /
 * `--input-file` — and `validateLocalInput`, the schema gate that runs on its
 * result.
 *
 * The platform resolves `manifest.input.schema` defaults and the
 * per-application stored values on every run, so a local run of the same
 * agent must resolve them too or it executes with different parameters than
 * the dashboard would. Layers 3-4 (schedule values, caller input on a
 * platform run) deliberately have no equivalent: the server owns that chain.
 */

import { describe, it, expect } from "bun:test";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import {
  resolveLocalInput,
  validateLocalInput,
  LockedInputFieldError,
} from "../src/commands/run/input.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { ExitError } from "./helpers/process-exit.ts";

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

/**
 * The gate that pairs with the resolver.
 *
 * The platform validates on every launch path (`parseRunInput`, the
 * scheduler, the inline-run preflight all follow `resolveEffectiveInput`
 * with `validateInput`). A local run reaches none of them, so the CLI has to
 * run the same check itself or `appstrate run --local` succeeds on an input
 * the dashboard would reject — nothing downstream enforces `required`, the
 * runtime only prints the word next to the field in the platform prompt.
 *
 * `validateLocalInput` exits the process on failure, so every test here
 * injects its own `createMemoryIO()` sink: no global stream or
 * `process.exit` is touched (the pattern issue #1180 retired), and the exit
 * arrives as the shared `ExitError` carrying the code.
 */
describe("validateLocalInput", () => {
  const REQUIRED_BUNDLE = makeBundle({
    schema: {
      type: "object",
      properties: { topic: { type: "string" }, tone: { type: "string", default: "neutral" } },
      required: ["topic"],
    },
  });

  it("accepts a resolved input that satisfies the schema", () => {
    const { io, stdout, stderr } = createMemoryIO();
    expect(() =>
      validateLocalInput(REQUIRED_BUNDLE, { topic: "weekly", tone: "neutral" }, io),
    ).not.toThrow();
    expect(stdout()).toBe("");
    expect(stderr()).toBe("");
  });

  it("exits non-zero naming the required field no layer answered", () => {
    const { io, stdout } = createMemoryIO();
    // What `resolveLocalInput` produces for this bundle when the caller
    // passes nothing: the author default for `tone`, and `topic` absent.
    const resolved = resolveLocalInput(REQUIRED_BUNDLE, {});
    expect(resolved).toEqual({ tone: "neutral" });
    try {
      validateLocalInput(REQUIRED_BUNDLE, resolved, io);
      throw new Error("expected validateLocalInput to exit");
    } catch (err) {
      expect(err).toBeInstanceOf(ExitError);
      expect((err as ExitError).code).toBe(1);
    }
    expect(stdout()).toContain("topic");
  });

  it("exits non-zero naming a field whose value violates the schema", () => {
    const bundle = makeBundle({
      schema: {
        type: "object",
        properties: { tone: { type: "string", enum: ["neutral", "formal"] } },
      },
    });
    const { io, stdout } = createMemoryIO();
    try {
      validateLocalInput(bundle, { tone: "shouty" }, io);
      throw new Error("expected validateLocalInput to exit");
    } catch (err) {
      expect(err).toBeInstanceOf(ExitError);
      expect((err as ExitError).code).toBe(1);
    }
    expect(stdout()).toContain("tone");
  });

  it("validates the RESOLVED value, not the caller's raw input", () => {
    // `topic` is required and the caller supplies nothing — but the author
    // default answers it, exactly as it would on the platform. Validating
    // the raw caller input here would reject a run the dashboard accepts.
    const bundle = makeBundle({
      schema: {
        type: "object",
        properties: { topic: { type: "string", default: "weekly" } },
        required: ["topic"],
      },
    });
    const { io } = createMemoryIO();
    expect(() => validateLocalInput(bundle, resolveLocalInput(bundle, {}), io)).not.toThrow();
  });

  it("accepts anything when the agent declares no input schema", () => {
    const { io, stdout } = createMemoryIO();
    expect(() => validateLocalInput(makeBundle(undefined), { anything: 1 }, io)).not.toThrow();
    expect(() =>
      validateLocalInput(makeBundle({ ui_hints: {} }), { anything: 1 }, io),
    ).not.toThrow();
    expect(stdout()).toBe("");
  });

  it("accepts a caller key the schema does not declare", () => {
    // `resolveLocalInput` deliberately keeps undeclared caller keys, so the
    // gate must not reject them under a schema that stays open.
    const { io } = createMemoryIO();
    expect(() => validateLocalInput(TONE_BUNDLE, { tone: "formal", extra: 1 }, io)).not.toThrow();
  });
});
