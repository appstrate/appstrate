// SPDX-License-Identifier: Apache-2.0

// The hosts serving OAuth documents may be chosen by the user who creates a connection (AFPS §7.12,
// §8.7): their bodies are read under a cap, a larger one refused, not parsed.
export const MAX_METADATA_BODY_BYTES = 64 * 1024;
/** Token responses carry an `id_token`, which may hold many claims. */
export const MAX_TOKEN_BODY_BYTES = 512 * 1024;

/**
 * The body as text, or `null` once it crosses `maxBytes` (the stream cancelled). Counted on the
 * decoded stream: neither a lying `content-length` nor a compressed bomb gets past it.
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

/** {@link readTextUnder} parsed as JSON; throws past the cap or (a `SyntaxError`) on non-JSON. */
export async function parseJsonUnder(res: Response, maxBytes: number): Promise<unknown> {
  const text = await readTextUnder(res, maxBytes);
  if (text === null) throw new RangeError(`response body exceeds ${maxBytes} bytes`);
  return JSON.parse(text);
}
