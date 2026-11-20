// SPDX-License-Identifier: Apache-2.0

/**
 * Which files the chat hands a model: the one rule the engine applies before it sends a file and
 * the composer applies before it warns that one will not be read. Block only what is declared
 * impossible; otherwise send, and the provider decides. A field that is not known never blocks.
 */

/**
 * API shapes the chat has a PDF wire format for, each encoded in `pi-chat/native-pdf.ts`.
 * Mistral's conversations API takes documents only by hosted URL, so it has none.
 */
export const PDF_WIRE_APIS = [
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "openai-completions",
] as const;
export type PdfWireApi = (typeof PDF_WIRE_APIS)[number];

export function hasPdfWireFormat(api: string): api is PdfWireApi {
  return (PDF_WIRE_APIS as readonly string[]).includes(api);
}

/** What one turn sends the model, computed once per turn. */
export interface FileDelivery {
  image: boolean;
  pdf: boolean;
}

export function fileDelivery(model: {
  /** `null`/`undefined`: the API shape is not known (a catalog still loading). */
  api?: string | null;
  /** `null`/`undefined`: the modalities are not known (an alias, a custom model). */
  input?: readonly string[] | null;
}): FileDelivery {
  const image = model.input?.includes("image") ?? true;
  // Providers read a PDF's pages as images, so a model declared text-only reads no PDF either.
  return { image, pdf: image && (model.api ? hasPdfWireFormat(model.api) : true) };
}
