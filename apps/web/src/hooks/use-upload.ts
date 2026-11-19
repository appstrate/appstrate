// SPDX-License-Identifier: Apache-2.0

/**
 * THE uploader every file input uses: the staged upload (`api/uploads.ts`) plus a refresh of the
 * org storage gauge. `used_bytes` counts durable files, materialized slightly after the staged
 * upload, so the refresh folds in what is materialized so far, not an exact after-image.
 */

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UploadFn } from "@appstrate/ui/schema-form";
import { uploadInSpace } from "../api/uploads";
import { invalidateOrgDetail } from "../lib/query-keys";

/** Into the space the caller names (the chat attaches where the conversation acts), else the current one. */
export function useUploadInSpace(): (
  file: File,
  spaceId: string | undefined,
  signal?: AbortSignal,
) => Promise<string> {
  const queryClient = useQueryClient();
  return useCallback(
    async (file, spaceId, signal) => {
      const uri = await uploadInSpace(file, spaceId, signal);
      void invalidateOrgDetail(queryClient);
      return uri;
    },
    [queryClient],
  );
}

/** {@link useUploadInSpace} into the current space, as a form's file field takes it. */
export function useUploadClient(): UploadFn {
  const upload = useUploadInSpace();
  return useCallback((file, signal) => upload(file, undefined, signal), [upload]);
}
