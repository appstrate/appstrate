// SPDX-License-Identifier: Apache-2.0

/**
 * Subset of curl's `-w` metrics that we can derive from Web fetch.
 *
 *  tStart / tFirstByte / tEnd are `performance.now()` timestamps
 *    (milliseconds since CLI launch). Converted to seconds in the
 *    formatter — curl emits seconds with 6-decimal precision.
 *  sizeUpload is `null` when the body shape doesn't expose a length
 *    (FormData, ReadableStream) — we render that as `0` rather than
 *    making up a number.
 */
export interface WriteOutMetrics {
  tStart: number;
  tFirstByte: number | null;
  tEnd: number | null;
  sizeDownload: number;
  sizeUpload: number | null;
  httpCode: number;
  urlEffective: string;
  numRedirects: number;
  responseHeaders: Record<string, string>;
  exitCode: number;
}

/**
 * Best-effort synchronous size of a request body. Matches the
 * shapes `buildBody()` produces:
 *   - `undefined` → 0
 *   - `string`    → UTF-8 byte length
 *   - Bun.file(...) handle → `.size` getter
 *   - FormData / ReadableStream → unknown (null)
 */
export function sizeOfBody(body: unknown): number | null {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  if (body && typeof body === "object" && "size" in body) {
    const s = (body as { size: unknown }).size;
    if (typeof s === "number") return s;
  }
  return null;
}

/**
 * Expand a curl `-w` format string. Supported variables:
 *   %{http_code}            Final response status (0 on connect failure)
 *   %{http_version}         Hardcoded "1.1" — fetch doesn't expose the real version
 *   %{size_download}        Body bytes received
 *   %{size_upload}          Body bytes sent (0 when unknown)
 *   %{time_total}           Total request time, seconds, 6 decimals
 *   %{time_starttransfer}   Time until first response byte, seconds
 *   %{url_effective}        Final URL (after redirects with `-L`)
 *   %{num_redirects}        1 if -L followed a redirect, else 0
 *   %{header_json}          Response headers as a JSON object
 *   %{exitcode}             Our process exit code (0 on success)
 *
 * Escape sequences `\n \r \t` are expanded in the format string
 * itself — agents that embed `-w "%{http_code}\n"` should get a
 * trailing newline regardless of shell quoting rules.
 * Unknown variables are passed through verbatim (matches curl).
 */
export function formatWriteOut(fmt: string, m: WriteOutMetrics): string {
  const expanded = fmt.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  const secondsSince = (t: number | null): string => {
    if (t === null) return "0.000000";
    return ((t - m.tStart) / 1000).toFixed(6);
  };
  return expanded.replace(/%\{([a-z_]+)\}/g, (match, name: string) => {
    switch (name) {
      case "http_code":
        return String(m.httpCode);
      case "http_version":
        return "1.1";
      case "size_download":
        return String(m.sizeDownload);
      case "size_upload":
        return String(m.sizeUpload ?? 0);
      case "time_total":
        return secondsSince(m.tEnd);
      case "time_starttransfer":
        return secondsSince(m.tFirstByte);
      case "url_effective":
        return m.urlEffective;
      case "num_redirects":
        return String(m.numRedirects);
      case "header_json":
        return JSON.stringify(m.responseHeaders);
      case "exitcode":
        return String(m.exitCode);
      default:
        return match;
    }
  });
}
