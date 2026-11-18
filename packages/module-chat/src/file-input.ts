// SPDX-License-Identifier: Apache-2.0

/**
 * Which files the chat hands a model: the one rule the engine applies before it sends a file and
 * the composer applies before it warns that one will not be read. Block only what is declared
 * impossible; otherwise send, and the provider decides — the user chose the model.
 */

import type { ModelInputModality } from "@appstrate/core/module";

/** API shapes the chat has a PDF wire format for. */
const PDF_WIRE_APIS: readonly string[] = ["openai-responses"];

export type FileInputKind = "image" | "pdf";

export interface FileInputModel {
  api: string | null | undefined;
  input: readonly string[] | null | undefined;
}

/** What one turn sends the model, computed once per turn. */
export interface FileDelivery {
  image: boolean;
  pdf: boolean;
}

/** `true` = send, `false` = declared impossible, `null` = cannot tell (the API shape is hidden). */
export function acceptsFileInput(model: FileInputModel, kind: FileInputKind): boolean | null {
  if (kind === "image") return model.input ? model.input.includes("image") : true;
  return model.api ? PDF_WIRE_APIS.includes(model.api) : null;
}

export function fileDelivery(model: FileInputModel): FileDelivery {
  return {
    image: acceptsFileInput(model, "image") !== false,
    pdf: acceptsFileInput(model, "pdf") === true,
  };
}

/** The modalities the chat binding hands Pi: unknown ones are not a refusal, so images still go. */
export function piInputModalities(
  input: readonly ModelInputModality[] | null | undefined,
): ModelInputModality[] {
  return input ? [...input] : ["text", "image"];
}
