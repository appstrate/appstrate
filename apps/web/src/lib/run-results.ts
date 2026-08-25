// SPDX-License-Identifier: Apache-2.0

export interface RunResultsStateInput {
  status: string;
  output: Record<string, unknown> | null;
  expectedDocumentCount: number;
  loadedDocumentCount: number;
  documentsLoading: boolean;
  documentsError: boolean;
  hasRunMemory: boolean;
  hasPrimaryDocument: boolean;
}

/** Keep "no results" distinct from "results could not be loaded". */
export function classifyRunResults(input: RunResultsStateInput) {
  const hasStructuredOutput = !!input.output && Object.keys(input.output).length > 0;
  const shouldRenderDocuments =
    input.documentsLoading ||
    input.documentsError ||
    input.loadedDocumentCount > 0 ||
    input.expectedDocumentCount > 0;
  const hasProduction =
    shouldRenderDocuments || hasStructuredOutput || input.hasRunMemory || input.hasPrimaryDocument;
  const hasDurableProduction =
    input.loadedDocumentCount > 0 ||
    input.expectedDocumentCount > 0 ||
    hasStructuredOutput ||
    input.hasRunMemory ||
    input.hasPrimaryDocument;

  return {
    hasStructuredOutput,
    shouldRenderDocuments,
    hasProduction,
    isPartial: (input.status === "failed" || input.status === "cancelled") && hasDurableProduction,
  };
}
