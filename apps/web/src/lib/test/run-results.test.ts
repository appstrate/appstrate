// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { classifyRunResults } from "../run-results";

const classify = (overrides: Partial<Parameters<typeof classifyRunResults>[0]> = {}) =>
  classifyRunResults({
    status: "success",
    output: null,
    expectedDocumentCount: 0,
    loadedDocumentCount: 0,
    documentsLoading: false,
    documentsError: false,
    hasRunMemory: false,
    hasPrimaryDocument: false,
    ...overrides,
  });

describe("run results classification", () => {
  it("does not treat an empty structured object as production", () => {
    expect(classify({ output: {} }).hasProduction).toBe(false);
  });

  it("does not turn a document API error into an empty run", () => {
    expect(classify({ expectedDocumentCount: 2, documentsError: true })).toMatchObject({
      shouldRenderDocuments: true,
      hasProduction: true,
    });
    expect(classify({ status: "failed", documentsError: true }).isPartial).toBe(false);
  });

  it("marks retained output from failed and cancelled runs as partial", () => {
    expect(classify({ status: "failed", output: { step: 2 } }).isPartial).toBe(true);
    expect(classify({ status: "cancelled", hasRunMemory: true }).isPartial).toBe(true);
  });
});
