// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol guards for `uploadClient` — THE uploader behind every file input
 * (`<SchemaForm upload={...} />` via `hooks/use-upload.ts`).
 *
 * The same protocol used to be specified by `packages/ui/test/upload-client.test.ts`,
 * but it covered `createUploader`, a parallel implementation nothing called;
 * #1178 removed both. These cases re-anchor it on the implementation that ships.
 *
 * Both legs are injected rather than stubbed on `globalThis.fetch`: the typed
 * client builds a Request from a relative spec path, which only resolves inside
 * a browser (see the `UploadDeps` note in `uploads.ts`). Injection also keeps
 * the two legs independently observable — and leaks no global into the rest of
 * the single-process suite.
 *
 * Error-shape behaviour (RFC 9457 `detail`, `statusText` fallback) is NOT
 * asserted here: `uploads.ts` parses no errors, it inherits them from the
 * shared client middleware. Those cases live in `client.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { uploadClient } from "../uploads.ts";

const DESCRIPTOR = {
  id: "upl_abc",
  uri: "upload://upl_abc",
  url: "https://storage.example.com/upl_abc",
  method: "PUT" as const,
  headers: { "Content-Type": "text/plain" },
};

interface PostCall {
  path: string;
  body: { name: string; size: number; mime: string };
  signal?: AbortSignal | null;
}
interface PutCall {
  url: string;
  init?: RequestInit;
}

/**
 * A recording stand-in for the two injected legs. `descriptor: null` models a
 * 2xx with no body (the typed client yields `data: undefined`); `putStatus`
 * drives the sink so a failing PUT needs no bespoke stub.
 */
function harness(options: { descriptor?: typeof DESCRIPTOR | null; putStatus?: number } = {}) {
  const { descriptor = DESCRIPTOR, putStatus = 200 } = options;
  const posts: PostCall[] = [];
  const puts: PutCall[] = [];
  const deps = {
    client: {
      POST: (async (path: string, init: { body: PostCall["body"]; signal?: AbortSignal }) => {
        posts.push({ path, body: init.body, signal: init.signal });
        return { data: descriptor ?? undefined, error: undefined, response: new Response() };
      }) as never,
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      puts.push({ url: String(url), init });
      return new Response(null, {
        status: putStatus,
        statusText: putStatus === 502 ? "Bad Gateway" : "",
      });
    }) as unknown as typeof globalThis.fetch,
  };
  return { deps, posts, puts };
}

describe("uploadClient", () => {
  it("POSTs the descriptor, PUTs the bytes to the returned url, returns the uri", async () => {
    const { deps, posts, puts } = harness();
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });

    const uri = await uploadClient(file, undefined, deps);

    expect(uri).toBe("upload://upl_abc");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe("/api/uploads");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe("https://storage.example.com/upl_abc");
    expect(puts[0]!.init?.method).toBe("PUT");
    expect(puts[0]!.init?.headers).toEqual({ "Content-Type": "text/plain" });
    // The raw bytes, not a FormData wrapper — the sink stores the body verbatim.
    expect(puts[0]!.init?.body).toBe(file);
  });

  it("describes the file by name, size and mime in the descriptor request", async () => {
    const { deps, posts } = harness();

    await uploadClient(new File(["hello"], "hello.txt", { type: "text/plain" }), undefined, deps);

    expect(posts[0]!.body.name).toBe("hello.txt");
    expect(posts[0]!.body.size).toBe(5);
    expect(posts[0]!.body.mime).toMatch(/^text\/plain/);
  });

  it("falls back to application/octet-stream for a file the browser gave no type", async () => {
    const { deps, posts } = harness();

    // No extension, no explicit type — `file.type` is the empty string, and an
    // empty mime is not something the sink can store.
    await uploadClient(new File(["x"], "blob"), undefined, deps);

    expect(posts[0]!.body.mime).toBe("application/octet-stream");
  });

  it("throws when the sink rejects the PUT", async () => {
    const { deps } = harness({ putStatus: 502 });

    await expect(uploadClient(new File(["x"], "x.txt"), undefined, deps)).rejects.toThrow(
      /^upload failed: 502 Bad Gateway$/,
    );
  });

  it("throws when the descriptor response carries no body", async () => {
    const { deps, puts } = harness({ descriptor: null });

    await expect(uploadClient(new File(["x"], "x.txt"), undefined, deps)).rejects.toThrow(
      "upload failed: empty descriptor response",
    );
    // And never reaches the sink with an undefined url.
    expect(puts).toHaveLength(0);
  });

  it("forwards the AbortSignal to both legs", async () => {
    const { deps, posts, puts } = harness();
    const controller = new AbortController();

    await uploadClient(new File(["x"], "x.txt"), controller.signal, deps);

    // Cancelling the form must cancel the upload in flight, whichever leg it is
    // on: a signal wired to only one of them leaves the other running.
    expect(posts[0]!.signal).toBe(controller.signal);
    expect(puts[0]!.init?.signal).toBe(controller.signal);
  });
});
