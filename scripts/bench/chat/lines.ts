// SPDX-License-Identifier: Apache-2.0

/**
 * Lines of a UTF-8 byte stream, each yielded the moment its newline arrives —
 * the bench timestamps a line on arrival, so nothing may sit in a buffer
 * waiting for more input. A trailing line without a newline is yielded at the
 * end. `onText` sees the decoded text as it comes (the server log file).
 */
export async function* lines(
  stream: ReadableStream<Uint8Array>,
  onText?: (text: string) => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    onText?.(text);
    buffered += text;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      yield buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
    }
  }
  const tail = decoder.decode();
  onText?.(tail);
  buffered += tail;
  if (buffered) yield buffered;
}
