// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// Upload contract for the FileWidget. The widget never talks to a network
// endpoint itself: the host application injects an `UploadFn` via
// `<SchemaForm upload={...} />`, so authentication, headers and error
// semantics stay the host's concern.

export interface UploadFn {
  /** Uploads `file` and resolves to its opaque `upload://upl_xxx` URI. */
  (file: File, signal?: AbortSignal): Promise<string>;
}
