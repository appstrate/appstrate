// SPDX-License-Identifier: Apache-2.0

export interface ConnectStreamEvent {
  event: string;
  data: unknown;
}

export function browserUseInteractionUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new Error("Invalid browser interaction URL");
  }
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (host !== "browser-use.com" && !host.endsWith(".browser-use.com"))
  ) {
    throw new Error("Invalid browser interaction URL");
  }
  return url.toString();
}

export function browserCompanionObservationUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.set("observe", "1");
  return url.toString();
}

function parseSseFrame(frame: string): ConnectStreamEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: JSON.parse(data.join("\n")) as unknown };
}

export async function readConnectEventStream(
  response: Response,
  onEvent: (event: ConnectStreamEvent) => void | Promise<void>,
): Promise<void> {
  if (!response.body) throw new Error("Browser connection stream is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) await onEvent(parsed);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const parsed = parseSseFrame(buffer);
      if (parsed) await onEvent(parsed);
    }
  } finally {
    reader.releaseLock();
  }
}
