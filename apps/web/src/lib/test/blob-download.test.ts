// SPDX-License-Identifier: Apache-2.0

/**
 * `triggerBlobDownload` — THE place the SPA turns fetched bytes into a file
 * download, and therefore the one place its two guards have to hold: the
 * empty-body normalisation (#1118) and the inert blob type.
 *
 * apps/web has no DOM harness, so the three browser APIs the helper touches
 * (`URL.createObjectURL`, `URL.revokeObjectURL`, `document`) are installed on
 * `globalThis` as recording fakes for the duration of one call and restored
 * afterwards — the same shape `stores/test/pairing-store.test.ts` uses for
 * `localStorage`. Stubbing the globals rather than `mock.module()` (banned) is
 * also what keeps the helper's two-parameter signature honest: no injection
 * seam is added for the test's benefit, so what runs here is what ships.
 */

import { describe, it, expect } from "bun:test";
import { triggerBlobDownload } from "../blob-download";

interface FakeAnchor {
  href: string;
  download: string;
  click(): void;
}

interface Recorded {
  /** The anchor the helper built, after it finished with it. */
  anchor: FakeAnchor;
  /** Every blob handed to `createObjectURL`, in order. */
  blobs: Blob[];
  /** Every URL handed to `revokeObjectURL`, in order. */
  revoked: string[];
  /** Ordered trace of the DOM calls, including whether the click was attached. */
  trace: string[];
}

/**
 * Run the helper against recording fakes and hand back everything it did.
 * Globals are restored in a `finally` so one failing expectation cannot leak a
 * fake `document` into the next test file.
 */
function capture(data: BlobPart | undefined, filename: string): Recorded {
  const g = globalThis as { document?: unknown };
  const realDocument = g.document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;

  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const trace: string[] = [];
  let attached = false;

  const anchor: FakeAnchor = {
    href: "",
    download: "",
    click() {
      // Recorded with its attachment state: an anchor clicked before
      // `appendChild` (or after `removeChild`) does not reliably download.
      trace.push(attached ? "click:attached" : "click:detached");
    },
  };

  URL.createObjectURL = (blob: Blob) => {
    blobs.push(blob);
    trace.push("createObjectURL");
    return `blob:test/${blobs.length}`;
  };

  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
    trace.push("revokeObjectURL");
  };

  g.document = {
    createElement: (tag: string) => {
      trace.push(`createElement:${tag}`);
      return anchor;
    },
    body: {
      appendChild: (node: unknown) => {
        attached = node === anchor;
        trace.push("appendChild");
        return node;
      },
      removeChild: (node: unknown) => {
        if (node === anchor) attached = false;
        trace.push("removeChild");
        return node;
      },
    },
  };

  try {
    triggerBlobDownload(data, filename);
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    if (realDocument === undefined) delete g.document;
    else g.document = realDocument;
  }

  return { anchor, blobs, revoked, trace };
}

describe("triggerBlobDownload", () => {
  it("downloads an EMPTY file when the body is undefined, not the word 'undefined'", async () => {
    // The #1118 short-circuit: openapi-fetch resolves `{ data: undefined }` for
    // a zero-byte body BEFORE `parseAs` is honoured, on a fully successful 200.
    // Without the `?? ""`, `new Blob([undefined])` stringifies its argument and
    // writes a 9-byte file reading "undefined".
    const { blobs } = capture(undefined, "empty.txt");
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.size).toBe(0);
    expect(await blobs[0]!.text()).toBe("");
  });

  it("passes the bytes through unchanged when there is a body", async () => {
    const { blobs } = capture("name: skill\n", "SKILL.md");
    expect(await blobs[0]!.text()).toBe("name: skill\n");
  });

  it("pins an inert blob type regardless of the type the response carried", () => {
    // `/api/documents/{id}/content` serves the stored, uploader-controlled
    // `row.mime`. A `blob:` URL inherits the platform origin, so the type the
    // blob carries is the one that would decide whether those bytes are ever
    // interpreted — it is re-pinned here, never forwarded.
    for (const body of [
      new Blob(["<script>alert(1)</script>"], { type: "text/html" }),
      new Blob(["{}"], { type: "application/json" }),
      new Blob([]),
      undefined,
    ]) {
      const { blobs } = capture(body, "report.html");
      expect(blobs[0]!.type).toBe("application/octet-stream");
    }
  });

  it("names the anchor with the caller's filename and points it at the object URL", () => {
    const { anchor, trace } = capture("bytes", "acme-tidy-1.2.3.afps");
    expect(anchor.download).toBe("acme-tidy-1.2.3.afps");
    expect(anchor.href).toBe("blob:test/1");
    expect(trace).toContain("createElement:a");
  });

  it("clicks the anchor while it is attached, then detaches it", () => {
    const { trace } = capture("bytes", "file.bin");
    expect(trace).toEqual([
      "createObjectURL",
      "createElement:a",
      "appendChild",
      "click:attached",
      "removeChild",
      "revokeObjectURL",
    ]);
  });

  it("revokes the object URL it created (no leaked blob handle)", () => {
    const { revoked } = capture("bytes", "file.bin");
    expect(revoked).toEqual(["blob:test/1"]);
  });

  it("lets a DOM failure propagate to the caller's own error handling", () => {
    // Every call site wraps the request AND this call in one try/catch that
    // toasts `error.downloadFailed`. The helper must not swallow anything, or
    // a failed download would report success.
    const g = globalThis as { document?: unknown };
    const realDocument = g.document;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = () => "blob:test/boom";
    g.document = {
      createElement: () => {
        throw new Error("no DOM");
      },
    };
    try {
      expect(() => triggerBlobDownload("bytes", "file.bin")).toThrow("no DOM");
    } finally {
      URL.createObjectURL = realCreate;
      if (realDocument === undefined) delete g.document;
      else g.document = realDocument;
    }
  });
});
