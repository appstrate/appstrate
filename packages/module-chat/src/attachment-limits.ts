// SPDX-License-Identifier: Apache-2.0

/**
 * How many of a message's attachments the engine sends the model, shared with the composer's
 * estimate. Pure and browser-safe: `ui/` imports it as well as `pi-chat/`.
 */

/** Images, and PDFs, one user message sends the model; the others go as pointer lines only. */
export const FILES_PER_KIND_PER_MESSAGE = 4;

/**
 * Raw PDF bytes one turn sends the model, in all. Holds one PDF at the resource read cap
 * (`RESOURCE_BLOB_MAX_BYTES`), the most a single PDF read returns.
 */
export const TURN_PDF_MAX_BYTES = 700 * 1024;
