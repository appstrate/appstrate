// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared input resolution: the layer merge, the single
 * overlay whose origin lets a host declare which source it has, the
 * host-injected refusal, and the launch contract (locked / prefilled /
 * prompted) the web launch form and the CLI both read.
 */

import { describe, it, expect } from "bun:test";
import type { JSONSchemaObject, SchemaWrapper } from "../src/form.ts";
import {
  assertFieldsUnlocked,
  partitionInputFields,
  resolveEffectiveInput,
  resolvedInputDefaults,
  withoutLockedFields,
  type AgentInputSettings,
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
  it("applies author < editor < overlay, last one wins", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      editorDefaults: { folder: "archive", limit: 50 },
      overlay: { origin: "input", values: { limit: 100, subject: "ad-hoc" } },
      lockedFieldError,
    });

    expect(resolved).toEqual({
      // author only — no higher layer touches it
      tone: "neutral",
      // editor beats author
      folder: "archive",
      // the overlay beats the editor
      limit: 100,
      // the overlay is the only layer that supplies it
      subject: "ad-hoc",
    });
  });

  it("resolves an overlay that supplied nothing — author + editor only", () => {
    expect(
      resolveEffectiveInput({
        schema: SCHEMA,
        overlay: { origin: "input", values: undefined },
        lockedFieldError,
      }),
    ).toEqual({
      tone: "neutral",
      folder: "inbox",
      limit: 10,
    });
  });

  it("resolves a scheduled fire the same way — only the origin differs", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      editorDefaults: { folder: "archive" },
      overlay: { origin: "schedule input", values: { folder: "sent" } },
      lockedFieldError,
    });
    expect(resolved.folder).toBe("sent");
  });

  it("leaves a property with no value at any layer ABSENT, not null", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      overlay: { origin: "input", values: undefined },
      lockedFieldError,
    });
    expect("subject" in resolved).toBe(false);
  });

  it("keeps a caller value that is null or empty — only an absent key falls through", () => {
    const resolved = resolveEffectiveInput({
      schema: SCHEMA,
      overlay: { origin: "input", values: { tone: "" } },
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
        overlay: { origin: "input", values: { folder: "sent" } },
        lockedFieldError,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TestLockedFieldError);
    expect((caught as TestLockedFieldError).field).toBe("folder");
    expect((caught as TestLockedFieldError).origin).toBe("input");
  });

  it("names the overlay's own origin, so the refusal points at the schedule", () => {
    let caught: unknown;
    try {
      resolveEffectiveInput({
        lockedFields: ["folder"],
        overlay: { origin: "schedule input", values: { folder: "sent" } },
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
      overlay: { origin: "input", values: { subject: "hello" } },
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

describe("launch contract", () => {
  const WRAPPER: SchemaWrapper = {
    schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        folder: { type: "string", default: "inbox" },
        limit: { type: "number" },
        tone: { type: "string" },
      },
      required: ["query", "folder"],
    },
    property_order: ["folder", "query", "limit", "tone"],
  };

  function settings(over: Partial<AgentInputSettings> = {}): AgentInputSettings {
    return { values: {}, locked_fields: [], ...over };
  }

  describe("resolvedInputDefaults", () => {
    it("overlays the stored value on the author default", () => {
      expect(resolvedInputDefaults(WRAPPER, settings({ values: { folder: "archive" } }))).toEqual({
        folder: "archive",
      });
    });

    it("leaves a field no layer supplies absent rather than null", () => {
      const resolved = resolvedInputDefaults(WRAPPER, settings());
      expect(resolved).toEqual({ folder: "inbox" });
      expect("query" in resolved).toBe(false);
    });
  });

  describe("partitionInputFields", () => {
    it("sorts each field into exactly one launch state, in presentation order", () => {
      const partition = partitionInputFields(
        WRAPPER,
        settings({ values: { limit: 10 }, locked_fields: ["tone"] }),
      );
      // `folder` has an author default, `limit` a stored value → both pre-filled.
      expect(partition).toEqual({
        locked: ["tone"],
        prefilled: ["folder", "limit"],
        prompted: ["query"],
      });
    });

    it("keeps a locked field locked even when it also has a value", () => {
      const partition = partitionInputFields(WRAPPER, settings({ locked_fields: ["folder"] }));
      expect(partition.locked).toEqual(["folder"]);
      expect(partition.prefilled).not.toContain("folder");
    });

    it("prompts everything when nothing is decided", () => {
      const bare: SchemaWrapper = {
        schema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
      };
      expect(partitionInputFields(bare, settings())).toEqual({
        locked: [],
        prefilled: [],
        prompted: ["a", "b"],
      });
    });

    it("returns three empty lists for an agent with no parameters", () => {
      expect(partitionInputFields(undefined, settings())).toEqual({
        locked: [],
        prefilled: [],
        prompted: [],
      });
    });
  });
});
