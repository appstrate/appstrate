// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the unified input resolution — the four-layer merge, the
 * locked-field refusal, and the two write-time guards.
 */

import { describe, it, expect } from "bun:test";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { ApiError } from "../../src/lib/errors.ts";
import {
  assertFieldsUnlocked,
  assertLockedFieldsSatisfiable,
  resolveEffectiveInput,
  withoutLockedFields,
} from "../../src/services/input-resolution.ts";

const SCHEMA: JSONSchemaObject = {
  type: "object",
  properties: {
    tone: { type: "string", default: "neutral" },
    folder: { type: "string", default: "inbox" },
    limit: { type: "integer", default: 10 },
    subject: { type: "string" },
  },
  required: ["subject"],
};

/** Assert `fn` throws an `ApiError` with the given status + code, and return it. */
function expectApiError(fn: () => unknown, status: number, code: string): ApiError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApiError);
  const err = caught as ApiError;
  expect(err.status).toBe(status);
  expect(err.code).toBe(code);
  return err;
}

describe("resolveEffectiveInput — four-layer precedence", () => {
  it("applies author < editor < schedule < caller, last one wins", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      editorDefaults: { folder: "archive", limit: 50 },
      scheduleValues: { limit: 100, subject: "weekly" },
      callerInput: { subject: "ad-hoc" },
    });

    expect(resolved).toEqual({
      // author only — no higher layer touches it
      tone: "neutral",
      // editor beats author
      folder: "archive",
      // schedule beats editor
      limit: 100,
      // caller beats schedule
      subject: "ad-hoc",
    });
  });

  it("passes an author default through when it is the only layer", () => {
    expect(resolveEffectiveInput({ schema: SCHEMA })).toEqual({
      tone: "neutral",
      folder: "inbox",
      limit: 10,
    });
  });

  it("lets the caller override an unlocked editor default", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      editorDefaults: { folder: "archive" },
      callerInput: { folder: "sent" },
    });
    expect(resolved.folder).toBe("sent");
  });

  it("refuses caller input on a locked field, naming the field", () => {
    const err = expectApiError(
      () =>
        resolveEffectiveInput({
          schema: SCHEMA,
          editorDefaults: { folder: "archive" },
          lockedFields: ["folder"],
          callerInput: { folder: "sent" },
        }),
      400,
      "locked_input_field",
    );
    expect(err.message).toContain("folder");
  });

  it("refuses schedule values on a locked field", () => {
    const err = expectApiError(
      () =>
        resolveEffectiveInput({
          schema: SCHEMA,
          lockedFields: ["folder"],
          scheduleValues: { folder: "sent" },
        }),
      400,
      "locked_input_field",
    );
    expect(err.message).toContain("folder");
  });

  it("keeps a locked field resolving from author + editor", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      editorDefaults: { folder: "archive" },
      lockedFields: ["folder", "tone"],
      callerInput: { subject: "hello" },
    });
    expect(resolved.folder).toBe("archive");
    expect(resolved.tone).toBe("neutral");
  });
});

describe("assertFieldsUnlocked", () => {
  it("is a no-op when nothing is locked", () => {
    expect(() => assertFieldsUnlocked({ folder: "sent" }, [])).not.toThrow();
    expect(() => assertFieldsUnlocked({ folder: "sent" }, undefined)).not.toThrow();
  });
});

describe("withoutLockedFields", () => {
  it("drops the locked keys and keeps the rest", () => {
    expect(withoutLockedFields({ a: 1, b: 2, c: 3 }, ["b"])).toEqual({ a: 1, c: 3 });
  });

  it("returns the values untouched when nothing is locked", () => {
    const values = { a: 1 };
    expect(withoutLockedFields(values, [])).toBe(values);
  });
});

describe("assertLockedFieldsSatisfiable", () => {
  it("refuses a required field locked with no value behind it", () => {
    const err = expectApiError(
      () => assertLockedFieldsSatisfiable(SCHEMA, ["subject"], {}),
      400,
      "locked_required_field_empty",
    );
    expect(err.message).toContain("subject");
  });

  it("accepts a required locked field that has an editor value", () => {
    expect(() =>
      assertLockedFieldsSatisfiable(SCHEMA, ["subject"], { subject: "fixed" }),
    ).not.toThrow();
  });

  it("accepts a required locked field satisfied by an author default", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { tone: { type: "string", default: "neutral" } },
      required: ["tone"],
    };
    expect(() => assertLockedFieldsSatisfiable(schema, ["tone"], {})).not.toThrow();
  });

  it("accepts locking an optional field with no value", () => {
    expect(() => assertLockedFieldsSatisfiable(SCHEMA, ["folder"], {})).not.toThrow();
  });
});
