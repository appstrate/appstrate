// SPDX-License-Identifier: Apache-2.0

/**
 * Which files the chat hands a model: the one rule the engine applies before it sends a file and
 * the composer applies before it warns that one will not be read. Block only what is declared
 * impossible; otherwise send, and the provider decides — the user chose the model.
 */

import { turnMetadataFromMessage, type FileInputKind } from "@appstrate/core/chat-turn-metadata";
import type { ModelInputModality } from "@appstrate/core/module";

/**
 * API shapes the chat has a PDF wire format for, each encoded in `pi-chat/native-pdf.ts`.
 * Mistral's conversations API documents PDFs only by hosted URL, so it has none.
 */
const PDF_WIRE_APIS = [
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "openai-completions",
] as const;

export type PdfWireApi = (typeof PDF_WIRE_APIS)[number];

export function isPdfWireApi(api: string | null | undefined): api is PdfWireApi {
  return (PDF_WIRE_APIS as readonly unknown[]).includes(api);
}

export interface FileInputModel {
  api: string | null | undefined;
  input: readonly string[] | null | undefined;
}

/** What one turn sends the model, computed once per turn. */
export interface FileDelivery {
  image: boolean;
  pdf: boolean;
  /** Kinds the model refused earlier in the conversation: it gets references only. */
  refused: readonly FileInputKind[];
}

/** The model-facing words for a file withheld because the model refused one of its kind earlier. */
export const FILE_INPUT_REFUSED_NOTE =
  "this model refused a file of this kind earlier in this conversation, so such files reach it only as references: say so rather than guess the content";

/** `true` = send, `false` = declared impossible, `null` = cannot tell (the API shape is hidden). */
export function acceptsFileInput(model: FileInputModel, kind: FileInputKind): boolean | null {
  const declaresImages = model.input ? model.input.includes("image") : null;
  if (kind === "image") return declaresImages !== false;
  // Providers read PDF pages as images: a model declared text-only cannot read one.
  if (declaresImages === false) return false;
  return model.api ? isPdfWireApi(model.api) : null;
}

/**
 * The file kinds this preset refused in the thread (`refusedFileKinds` on its turns). Sticky for
 * the rest of the thread; another preset is unaffected.
 */
export function refusedFileKinds(messages: readonly unknown[], presetId: string): FileInputKind[] {
  const kinds = new Set<FileInputKind>();
  for (const message of messages) {
    const turn = turnMetadataFromMessage(message);
    if (turn?.modelId !== presetId) continue;
    for (const kind of turn.refusedFileKinds ?? []) kinds.add(kind);
  }
  return [...kinds];
}

export function fileDelivery(
  model: FileInputModel,
  { refused = [] }: { refused?: readonly FileInputKind[] } = {},
): FileDelivery {
  return {
    image: !refused.includes("image") && acceptsFileInput(model, "image") !== false,
    pdf: !refused.includes("pdf") && acceptsFileInput(model, "pdf") === true,
    refused,
  };
}

/** The modalities the chat binding hands Pi: unknown ones are not a refusal, so images still go. */
export function piInputModalities(
  input: readonly ModelInputModality[] | null | undefined,
): ModelInputModality[] {
  return input ? [...input] : ["text", "image"];
}
