// SPDX-License-Identifier: Apache-2.0

/**
 * THE uploader every file input uses: the staged upload (`api/uploads.ts`) plus a refresh of the
 * org storage gauge. `used_bytes` counts durable files, materialized slightly after the staged
 * upload, so the refresh folds in what is materialized so far, not an exact after-image.
 */

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UploadFn } from "@appstrate/ui/schema-form";
import { uploadClient, uploadInSpace } from "../api/uploads";
import { invalidateOrgDetail } from "../lib/query-keys";

export function useUploadClient(): UploadFn {
  const queryClient = useQueryClient();
  return useCallback(
    async (file, signal) => {
      const uri = await uploadClient(file, signal);
      void invalidateOrgDetail(queryClient);
      return uri;
    },
    [queryClient],
  );
}

/** The same uploader, into a space the caller names (the chat attaches where the conversation acts). */
export function useUploadInSpace(): (
  file: File,
  spaceId: string,
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
