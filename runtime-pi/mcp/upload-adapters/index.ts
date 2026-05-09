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
export { UPLOAD_PROTOCOLS, UploadError } from "./types.ts";
