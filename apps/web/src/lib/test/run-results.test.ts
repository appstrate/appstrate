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

  it("keeps server-reported documents available when the document API fails", () => {
    expect(classify({ expectedDocumentCount: 2, documentsError: true })).toMatchObject({
      shouldRenderDocuments: true,
      hasProduction: true,
    });
  });

  it("does not qualify a document API error as production", () => {
    expect(classify({ status: "failed", documentsError: true })).toMatchObject({
      shouldRenderDocuments: false,
      hasProduction: false,
      isPartial: false,
    });
  });

  it("marks retained output from failed and cancelled runs as partial", () => {
    expect(classify({ status: "failed", output: { step: 2 } }).isPartial).toBe(true);
    expect(classify({ status: "cancelled", hasRunMemory: true }).isPartial).toBe(true);
  });
});
