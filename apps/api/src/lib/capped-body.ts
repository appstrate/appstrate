// SPDX-License-Identifier: Apache-2.0

/**
 * A response body read under `maxBytes`, or null once it crosses, the stream
 * cancelled on the spot. The budget is spent on the stream: a declared
 * `content-length` from an endpoint that is not ours is not a bound.
 */
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
