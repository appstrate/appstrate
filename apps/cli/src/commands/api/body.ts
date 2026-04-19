// SPDX-License-Identifier: Apache-2.0

import type { ApiCommandOptions, ApiCommandIO } from "./types.ts";

export type BuiltBody = {
  // `unknown` because our tsconfig doesn't expose `BodyInit`; actual
  // runtime shapes: string | Blob | FormData | ReadableStream.
  body?: unknown;
  usesStdin: boolean;
};

/**
 * Read a body-data reference into a string. `-` reads stdin to
 * exhaustion; anything else is a filesystem path read through
 * `Bun.file`. Used by both `--data-urlencode` parsing and `-G` query
 * projection — the two historical copies of this routine lived inline
 * inside `extractUrlencodeParts` and `collectGetDataAsQuery` and drifted
 * subtly (chunk accumulation shape, empty-reader early-exit). Unified
 * here so future fixes land in one place.
 */
async function readRefAsString(ref: string, io: ApiCommandIO): Promise<string> {
  if (ref === "-") {
    const reader = io.stdinStream?.().getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  }
  return Bun.file(ref).text();
}

export async function buildBody(opts: ApiCommandOptions, io: ApiCommandIO): Promise<BuiltBody> {
  // P2e — `-T path` uploads the raw file contents as the body. `-T -`
  // streams stdin. Mutual exclusion with -d/-F is enforced at the
  // apiCommand level before we get here.
  if (opts.uploadFile !== undefined) {
    if (opts.uploadFile === "-") {
      return { body: io.stdinStream?.(), usesStdin: true };
    }
    return { body: Bun.file(opts.uploadFile), usesStdin: false };
  }

  // --data-urlencode: repeat-merge into a `k=v&k=v` body. Non-`-G`
  // path only — `-G` already projected these into the query string
  // upstream and cleared `dataUrlencode` on `effectiveOpts`. If any
  // entry reads from stdin (`@-` / `name@-`) we flag `usesStdin` so
  // the outer retry logic disables retry (stdin can't be replayed).
  if (Array.isArray(opts.dataUrlencode) && opts.dataUrlencode.length > 0) {
    const usesStdin = opts.dataUrlencode.some((v) => v === "@-" || v.endsWith("@-"));
    const parts: string[] = [];
    for (const raw of opts.dataUrlencode) {
      parts.push(await parseUrlencodePair(raw, io));
    }
    return { body: parts.join("&"), usesStdin };
  }

  // Multipart wins if present.
  if (opts.form.length > 0) {
    const fd = new FormData();
    for (const raw of opts.form) {
      const eq = raw.indexOf("=");
      if (eq === -1) continue;
      const key = raw.slice(0, eq);
      const value = raw.slice(eq + 1);
      // curl -F 'k=@path[;type=mime]'
      if (value.startsWith("@")) {
        const semi = value.indexOf(";type=");
        const pathPart = semi === -1 ? value.slice(1) : value.slice(1, semi);
        const typeOverride = semi === -1 ? undefined : value.slice(semi + ";type=".length);
        const file = Bun.file(pathPart);
        const basename = pathPart.split("/").pop() || pathPart;
        // Bun's multipart serializer reads the filename from the
        // underlying BunFile's absolute path — wrapping in `new File`
        // client-side doesn't override it. To force the basename AND
        // apply any user-supplied MIME, materialize the bytes through
        // a Blob then construct a fresh File whose name is what we
        // want. Trade-off: the whole file gets loaded into memory
        // before upload (streaming is lost). For CLI-scale payloads
        // (package ZIPs, JSON, small binaries) this is fine; if the
        // user is uploading a multi-GB artifact they should stream it
        // via `-d @path` instead of `-F`.
        const bytes = await file.arrayBuffer();
        const type = typeOverride ?? file.type ?? "application/octet-stream";
        fd.append(key, new File([bytes], basename, { type }));
      } else {
        fd.append(key, value);
      }
    }
    return { body: fd, usesStdin: false };
  }

  // --data-raw (never interprets @)
  if (typeof opts.dataRaw === "string") {
    return { body: opts.dataRaw, usesStdin: false };
  }

  // --data-binary (@file or literal; preserves trailing newline)
  if (typeof opts.dataBinary === "string") {
    if (opts.dataBinary.startsWith("@")) {
      const p = opts.dataBinary.slice(1);
      if (p === "-") {
        return { body: io.stdinStream?.(), usesStdin: true };
      }
      return { body: Bun.file(p), usesStdin: false };
    }
    return { body: opts.dataBinary, usesStdin: false };
  }

  // -d / --data
  if (typeof opts.data === "string") {
    if (opts.data.startsWith("@")) {
      const p = opts.data.slice(1);
      if (p === "-") {
        return { body: io.stdinStream?.(), usesStdin: true };
      }
      return { body: Bun.file(p), usesStdin: false };
    }
    // curl -d strips a single trailing newline from literal bodies.
    const stripped = opts.data.endsWith("\n") ? opts.data.slice(0, -1) : opts.data;
    return { body: stripped, usesStdin: false };
  }

  return { body: undefined, usesStdin: false };
}

/**
 * Consume any body-data flags and project them into query-string
 * pairs. curl's `-G` semantics: each value is treated as an
 * already-encoded `k=v[&k=v]*` fragment. We split on `&` and pass
 * each pair through `-q`-style parsing in `buildUrl` (which uses
 * URL.searchParams for proper encoding of any embedded whitespace).
 */
export async function collectGetDataAsQuery(
  opts: ApiCommandOptions,
  io: ApiCommandIO,
): Promise<string[]> {
  const values: string[] = [];
  const pushStr = (raw: string): void => {
    const stripped = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    values.push(stripped);
  };
  if (typeof opts.data === "string") {
    if (opts.data.startsWith("@")) pushStr(await readRefAsString(opts.data.slice(1), io));
    else pushStr(opts.data);
  }
  if (typeof opts.dataRaw === "string") values.push(opts.dataRaw);
  if (typeof opts.dataBinary === "string") {
    if (opts.dataBinary.startsWith("@")) {
      values.push(await readRefAsString(opts.dataBinary.slice(1), io));
    } else {
      values.push(opts.dataBinary);
    }
  }
  // -d / --data-raw / --data-binary: curl treats the value as an
  // already-encoded `k=v[&k=v]*` fragment, so we split on `&` before
  // handing each pair to buildUrl (which in turn hands each to
  // searchParams.append for proper percent-encoding of stray bytes).
  const split = values.flatMap((v) => v.split("&")).filter(Boolean);

  // `--data-urlencode` is different: each entry is ONE pair whose
  // content portion may contain literal `&` / `=`. We must NOT split
  // on `&` (would corrupt `q=a&b` into two pairs), and we hand raw
  // content to searchParams so it percent-encodes exactly once.
  if (Array.isArray(opts.dataUrlencode)) {
    for (const raw of opts.dataUrlencode) {
      const { name, content } = await extractUrlencodeParts(raw, io);
      // `name=content` pair goes through buildUrl's split-on-first-`=`.
      // If content contains `=`, searchParams.append receives the full
      // post-`=` remainder — that's what we want (`q=a=b` → value "a=b").
      split.push(name === "" ? content : `${name}=${content}`);
    }
  }
  return split;
}

/**
 * Parse a `--data-urlencode` argument into its raw (un-encoded) name
 * and content parts. Supports curl's five forms:
 *
 *   `content`      → name="", content=raw
 *   `=content`     → name="", content=raw (leading `=` stripped)
 *   `name=content` → name, content=raw
 *   `@file`        → name="", content=read(file)
 *   `name@file`    → name, content=read(file)
 *
 * Selection rule: the first `=` or `@` is the separator (matches curl).
 * `@-` reads stdin. Callers responsible for encoding the `content`
 * (directly via `encodeURIComponent` for a body, or by handing it to
 * `URL.searchParams.append` for a query pair).
 */
async function extractUrlencodeParts(
  raw: string,
  io: ApiCommandIO,
): Promise<{ name: string; content: string }> {
  const eqIdx = raw.indexOf("=");
  const atIdx = raw.indexOf("@");
  if (eqIdx === -1 && atIdx === -1) {
    return { name: "", content: raw };
  }
  const firstIdx = eqIdx === -1 ? atIdx : atIdx === -1 ? eqIdx : Math.min(eqIdx, atIdx);
  const sep = raw[firstIdx];
  const name = raw.slice(0, firstIdx);
  const rest = raw.slice(firstIdx + 1);
  const content = sep === "@" ? await readRefAsString(rest, io) : rest;
  return { name, content };
}

/**
 * Percent-encode a `--data-urlencode` entry for body use. Content is
 * URL-encoded; the name (if any) stays literal — curl documents it
 * as "expected to be URL-encoded already".
 */
async function parseUrlencodePair(raw: string, io: ApiCommandIO): Promise<string> {
  const { name, content } = await extractUrlencodeParts(raw, io);
  const encoded = encodeURIComponent(content);
  return name === "" ? encoded : `${name}=${encoded}`;
}
