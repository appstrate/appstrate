import { supabase, ensureBucket } from "../lib/supabase.ts";
import type { UploadedFile, FileReference } from "./adapters/types.ts";

const BUCKET = "execution-files";
const SIGNED_URL_TTL_SECONDS = 3600; // 1h — outlasts max container execution

/** Sanitize filename for Supabase Storage (ASCII-only keys). */
function sanitizeStorageKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-zA-Z0-9._-]/g, "_"); // replace remaining non-ASCII / special chars
}

export const ensureFilesBucket = () => ensureBucket(BUCKET);

export async function uploadExecutionFiles(
  executionId: string,
  files: UploadedFile[],
): Promise<FileReference[]> {
  const refs: FileReference[] = [];
  for (const file of files) {
    const safeKey = sanitizeStorageKey(file.name);
    const path = `${executionId}/${safeKey}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, file.buffer, {
      contentType: file.type || "application/octet-stream",
      upsert: true,
    });
    if (error) throw new Error(`Failed to upload file '${file.name}': ${error.message}`);

    const { data: urlData, error: urlError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (urlError || !urlData?.signedUrl) {
      throw new Error(`Failed to create signed URL for '${file.name}'`);
    }

    refs.push({
      fieldName: file.fieldName,
      name: file.name,
      type: file.type,
      size: file.size,
      url: urlData.signedUrl,
    });
  }
  return refs;
}

export async function cleanupExecutionFiles(executionId: string): Promise<void> {
  const { data: files } = await supabase.storage.from(BUCKET).list(executionId);
  if (!files || files.length === 0) return;
  const paths = files.map((f) => `${executionId}/${f.name}`);
  await supabase.storage.from(BUCKET).remove(paths);
}
