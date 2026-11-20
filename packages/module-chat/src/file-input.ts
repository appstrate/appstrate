// SPDX-License-Identifier: Apache-2.0

/**
 * Which files the chat hands a model: the one rule the engine applies before it sends a file and
 * the composer applies before it warns that one will not be read. Block only what is declared
 * impossible; otherwise send, and the provider decides. A field that is not known never blocks.
 */

/** What a model of unknown modalities (an alias, a custom model) is sent: images included. */
export const UNKNOWN_INPUT_MODALITIES = ["text", "image"] as const;

export interface WireParts {
  text: string;
  image: string;
  /** Absent: the chat has no PDF wire format for this API. */
  pdf?: string;
}

/**
 * The content part types each API's payload carries: pi-ai's converters write the text and the
 * images, `pi-chat/native-pdf.ts` the PDFs. Mistral's conversations API takes documents only by
 * hosted URL, so it has no PDF. An API missing here is sent no PDF, and none of its parts is
 * recognised as a file.
 */
export const WIRE_PARTS = {
  "openai-responses": { text: "input_text", image: "input_image", pdf: "input_file" },
  "openai-codex-responses": { text: "input_text", image: "input_image", pdf: "input_file" },
  "anthropic-messages": { text: "text", image: "image", pdf: "document" },
  "openai-completions": { text: "text", image: "image_url", pdf: "file" },
  "mistral-conversations": { text: "text", image: "image_url" },
} as const satisfies Record<string, WireParts>;

type WireApi = keyof typeof WIRE_PARTS;
export type PdfWireApi = {
  [K in WireApi]: (typeof WIRE_PARTS)[K] extends { pdf: string } ? K : never;
}[WireApi];

export function wireParts(api: string | null | undefined): WireParts | undefined {
  return api && Object.hasOwn(WIRE_PARTS, api) ? WIRE_PARTS[api as WireApi] : undefined;
}

export function hasPdfWireFormat(api: string): api is PdfWireApi {
  return wireParts(api)?.pdf !== undefined;
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
  const image = (model.input ?? UNKNOWN_INPUT_MODALITIES).includes("image");
  // Providers read a PDF's pages as images, so a model declared text-only reads no PDF either.
  return { image, pdf: image && (model.api ? hasPdfWireFormat(model.api) : true) };
}
