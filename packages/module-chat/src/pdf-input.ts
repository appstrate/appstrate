// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a chat model reads a PDF natively: the one rule the engine applies before it sends a PDF
 * and the composer applies before it warns that one will not be read. OpenAI's Responses API is the
 * one adapter that carries a PDF (`input_file`), and it reads one as the text and an image of each
 * page, so a model without vision has no PDF input either.
 */
export function readsPdfNatively(model: {
  api: string | null | undefined;
  input: readonly string[] | null | undefined;
}): boolean {
  return model.api === "openai-responses" && model.input?.includes("image") === true;
}
