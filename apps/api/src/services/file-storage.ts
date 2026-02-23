import * as storage from "@appstrate/db/storage";
import type { UploadedFile, FileReference } from "./adapters/types.ts";

const BUCKET = "execution-files";

/** Sanitize filename for storage (ASCII-only keys). */
function sanitizeStorageKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-zA-Z0-9._-]/g, "_"); // replace remaining non-ASCII / special chars
}

export const ensureFilesBucket = () => storage.ensureBucket(BUCKET);

export async function uploadExecutionFiles(
  executionId: string,
  files: UploadedFile[],
): Promise<FileReference[]> {
  const refs: FileReference[] = [];
  for (const file of files) {
    const safeKey = sanitizeStorageKey(file.name);
    const path = `${executionId}/${safeKey}`;
    await storage.uploadFile(BUCKET, path, file.buffer);

    // Return a local path-based URL (served by the API)
    refs.push({
      fieldName: file.fieldName,
      name: file.name,
      type: file.type,
      size: file.size,
      url: `/api/files/${BUCKET}/${path}`,
    });
  }
  return refs;
}

export async function cleanupExecutionFiles(executionId: string): Promise<void> {
  await storage.deletePrefix(BUCKET, executionId);
}
