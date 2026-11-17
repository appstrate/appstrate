// SPDX-License-Identifier: Apache-2.0

/** A body under `maxBytes`, else null: counted on the stream, a foreign `content-length` is no bound. */
export async function readBodyUnder(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The first `maxBytes` of a body as text, or less once `until` holds; for a head or an endless stream. */
export async function readBodyPrefix(
  response: Response,
  maxBytes: number,
  until?: (text: string) => boolean,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, maxBytes - total);
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (until?.(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}
