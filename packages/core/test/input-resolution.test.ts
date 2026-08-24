// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared input resolution: the layer merge, the ordered
 * overlays that let a host declare exactly the sources it has, and the
 * host-injected refusal.
 */

import { describe, it, expect } from "bun:test";
import type { JSONSchemaObject } from "../src/form.ts";
import {
  assertFieldsUnlocked,
  resolveEffectiveInput,
  withoutLockedFields,
  type InputOverlayOrigin,
} from "../src/input-resolution.ts";

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

/** A host error carrying both halves of the refusal, so tests can assert them. */
class TestLockedFieldError extends Error {
  constructor(
    readonly field: string,
    readonly origin: InputOverlayOrigin,
  ) {
    super(`locked: ${field} (${origin})`);
  }
}

const lockedFieldError = (field: string, origin: InputOverlayOrigin) =>
  new TestLockedFieldError(field, origin);

describe("resolveEffectiveInput — layer precedence", () => {
  it("applies author < editor < overlays in listed order, last one wins", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      editorDefaults: { folder: "archive", limit: 50 },
      overlays: [
        { origin: "schedule input", values: { limit: 100, subject: "weekly" } },
        { origin: "input", values: { subject: "ad-hoc" } },
      ],
      lockedFieldError,
    });

    expect(resolved).toEqual({
      // author only — no higher layer touches it
      tone: "neutral",
      // editor beats author
      folder: "archive",
      // the first overlay beats the editor
      limit: 100,
      // the second overlay beats the first
      subject: "ad-hoc",
    });
  });

  it("resolves with no overlays at all — author + editor only", () => {
    expect(resolveEffectiveInput({ schema: SCHEMA, overlays: [], lockedFieldError })).toEqual({
      tone: "neutral",
      folder: "inbox",
      limit: 10,
    });
  });

  it("resolves a host that has ONE overlay (a local run: no schedules)", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      editorDefaults: { folder: "archive" },
      overlays: [{ origin: "input", values: { folder: "sent" } }],
      lockedFieldError,
    });
    expect(resolved.folder).toBe("sent");
  });

  it("leaves a property with no value at any layer ABSENT, not null", () => {
    const resolved = resolveEffectiveInput({ schema: SCHEMA, overlays: [], lockedFieldError });
    expect("subject" in resolved).toBe(false);
  });

  it("keeps a caller value that is null or empty — only an absent key falls through", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      overlays: [{ origin: "input", values: { tone: "" } }],
      lockedFieldError,
    });
    expect(resolved.tone).toBe("");
  });
});

describe("resolveEffectiveInput — locked fields", () => {
  it("refuses an overlay that sets a locked field, naming the field AND its origin", () => {
    let caught: unknown;
    try {
      resolveEffectiveInput({
        schema: SCHEMA,
        editorDefaults: { folder: "archive" },
        lockedFields: ["folder"],
        overlays: [{ origin: "input", values: { folder: "sent" } }],
        lockedFieldError,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TestLockedFieldError);
    expect((caught as TestLockedFieldError).field).toBe("folder");
    expect((caught as TestLockedFieldError).origin).toBe("input");
  });

  it("names the offending overlay's own origin, not the topmost one", () => {
    let caught: unknown;
    try {
      resolveEffectiveInput({
        lockedFields: ["folder"],
        overlays: [
          { origin: "schedule input", values: { folder: "sent" } },
          { origin: "input", values: { subject: "hello" } },
        ],
        lockedFieldError,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as TestLockedFieldError).origin).toBe("schedule input");
  });

  it("keeps a locked field resolving from the author and editor layers", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      editorDefaults: { folder: "archive" },
      lockedFields: ["folder", "tone"],
      overlays: [{ origin: "input", values: { subject: "hello" } }],
      lockedFieldError,
    });
    expect(resolved.folder).toBe("archive");
    expect(resolved.tone).toBe("neutral");
  });
});

describe("assertFieldsUnlocked", () => {
  it("is a no-op when nothing is locked", () => {
    const overlay = { origin: "input", values: { folder: "sent" } } as const;
    expect(() => assertFieldsUnlocked(overlay, [], lockedFieldError)).not.toThrow();
    expect(() => assertFieldsUnlocked(overlay, undefined, lockedFieldError)).not.toThrow();
  });

  it("is a no-op when the overlay supplied no values", () => {
    expect(() =>
      assertFieldsUnlocked({ origin: "input", values: undefined }, ["folder"], lockedFieldError),
    ).not.toThrow();
  });
});

describe("withoutLockedFields", () => {
  it("drops the locked keys and keeps the rest", () => {
    expect(withoutLockedFields({ a: 1, b: 2, c: 3 }, ["b"])).toEqual({ a: 1, c: 3 });
  });

  it("returns the values untouched when nothing is locked", () => {
    const values = { a: 1 };
    expect(withoutLockedFields(values, [])).toBe(values);
    expect(withoutLockedFields(values, undefined)).toBe(values);
  });
});
