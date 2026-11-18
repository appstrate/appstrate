// SPDX-License-Identifier: Apache-2.0

/**
 * Which files the chat hands a model: the one rule the engine applies before it sends a file and
 * the composer applies before it warns that one will not be read. Block only what is declared
 * impossible; otherwise send, and the provider decides — the user chose the model.
 */

import { turnMetadataFromMessage } from "@appstrate/core/chat-turn-metadata";
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

export type FileInputKind = "image" | "pdf";

export interface FileInputModel {
  api: string | null | undefined;
  input: readonly string[] | null | undefined;
}

/** What one turn sends the model, computed once per turn. */
export interface FileDelivery {
  image: boolean;
  pdf: boolean;
  /** The model refused a file earlier in the conversation: it gets references only. */
  refused: boolean;
}

/** The model-facing words for a file withheld because the model refused one earlier. */
export const FILE_INPUT_REFUSED_NOTE =
  "this model refused a file earlier in this conversation, so files reach it only as references: say so rather than guess the content";

/** `true` = send, `false` = declared impossible, `null` = cannot tell (the API shape is hidden). */
export function acceptsFileInput(model: FileInputModel, kind: FileInputKind): boolean | null {
  if (kind === "image") return model.input ? model.input.includes("image") : true;
  return model.api ? isPdfWireApi(model.api) : null;
}

/**
 * Whether this preset refused a file in the thread (`file_input_refused` on a failed turn it
 * answered). Sticky for the rest of the thread, every file kind; another preset is unaffected.
 */
export function fileInputRefused(messages: readonly unknown[], presetId: string): boolean {
  return messages.some((message) => {
    const turn = turnMetadataFromMessage(message);
    return turn?.errorReason === "file_input_refused" && turn.modelId === presetId;
  });
}

export function fileDelivery(model: FileInputModel, { refused = false } = {}): FileDelivery {
  if (refused) return { image: false, pdf: false, refused };
  return {
    image: acceptsFileInput(model, "image") !== false,
    pdf: acceptsFileInput(model, "pdf") === true,
    refused,
  };
}

/** The modalities the chat binding hands Pi: unknown ones are not a refusal, so images still go. */
export function piInputModalities(
  input: readonly ModelInputModality[] | null | undefined,
): ModelInputModality[] {
  return input ? [...input] : ["text", "image"];
}
