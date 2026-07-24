// SPDX-License-Identifier: Apache-2.0

/**
 * THE uploader every surface hands to a file input: the typed 2-step staged
 * upload (`api/uploads.ts`), plus a refresh of the org storage gauge.
 *
 * Why the invalidation lives here: uploading is the only user action that ADDS
 * bytes, and the gauge (`use-org-storage.ts`) + the "quota reached" alert are
 * read from the org detail. `used_bytes` counts durable documents, which the
 * server materializes from the staged upload slightly later (when the chat
 * message is sent, or when the run starts), so this refresh is what folds in
 * everything materialized so far rather than an exact after-image of this one
 * file — the gauge stops drifting instead of drifting forever.
 */

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UploadFn } from "@appstrate/ui/schema-form";
import { uploadClient } from "../api/uploads";
import { invalidateOrgStorage } from "./use-documents";

export function useUploadClient(): UploadFn {
  const queryClient = useQueryClient();
  return useCallback(
    async (file, signal) => {
      const uri = await uploadClient(file, signal);
      invalidateOrgStorage(queryClient);
      return uri;
    },
    [queryClient],
  );
}
