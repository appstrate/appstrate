// SPDX-License-Identifier: Apache-2.0

/**
 * Metadata and registration documents are a few KiB. The hosts serving them may be chosen by the
 * user who creates a connection (AFPS §7.12, §8.7), so their bodies are read under a cap and a
 * larger one is refused, not parsed.
 */
export const MAX_METADATA_BODY_BYTES = 64 * 1024;

/**
 * The body as text once read under `maxBytes`, or `null` once it crosses — the stream cancelled on
 * the spot. The budget is spent on the (already decoded) stream, so neither a lying
 * `content-length` nor a compressed bomb gets past it.
 */
export async function readTextUnder(
  res: Response,
  maxBytes = MAX_METADATA_BODY_BYTES,
): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks).text();
}

/** {@link readTextUnder} parsed as JSON: `null` past the cap or when the body is not JSON. */
export async function readJsonUnder(
  res: Response,
  maxBytes = MAX_METADATA_BODY_BYTES,
): Promise<unknown> {
  const text = await readTextUnder(res, maxBytes);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
