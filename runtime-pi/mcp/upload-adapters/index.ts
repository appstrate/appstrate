// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { googleResumableAdapter } from "./google-resumable.ts";
import { msResumableAdapter } from "./ms-resumable.ts";
import { s3MultipartAdapter } from "./s3-multipart.ts";
import { tusAdapter } from "./tus.ts";
import type { UploadAdapter, UploadProtocol } from "./types.ts";

/**
 * Registry of upload adapters keyed by protocol identifier. The Pi
 * tool's `uploadProtocol` enum is derived from this map's keys —
 * adding a new adapter is a single-line entry here plus the file.
 */
export const ADAPTERS: Readonly<Record<UploadProtocol, UploadAdapter>> = {
  "google-resumable": googleResumableAdapter,
  "s3-multipart": s3MultipartAdapter,
  tus: tusAdapter,
  "ms-resumable": msResumableAdapter,
};

/**
 * Look up an adapter by protocol identifier. Throws when the
 * protocol is unknown so the resolver fails fast — the Pi tool's
 * input schema enum already constrains the LLM, so a miss here
 * indicates a code-path bypass.
 */
export function getAdapter(protocol: UploadProtocol): UploadAdapter {
  const adapter = ADAPTERS[protocol];
  if (!adapter) {
    throw new Error(`No upload adapter registered for protocol '${protocol}'`);
  }
  return adapter;
}

export { googleResumableAdapter, msResumableAdapter, s3MultipartAdapter, tusAdapter };
export type {
  UploadAdapter,
  UploadProtocol,
  AdapterContext,
  ChunkInfo,
  SessionState,
  UploadResult,
  UploadSuccess,
  UploadFailure,
  AdapterProviderCall,
  AdapterProviderCallRequest,
  AdapterProviderResponse,
} from "./types.ts";
export { UPLOAD_PROTOCOLS } from "./types.ts";
