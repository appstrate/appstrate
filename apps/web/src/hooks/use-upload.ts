// SPDX-License-Identifier: Apache-2.0

/**
 * THE uploader every file input uses: the staged upload (`api/uploads.ts`) plus a refresh of the
 * org storage gauge. `used_bytes` counts durable files, materialized slightly after the staged
 * upload, so the refresh folds in what is materialized so far, not an exact after-image.
 */

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UploadFn } from "@appstrate/ui/schema-form";
import { uploadClient } from "../api/uploads";
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
