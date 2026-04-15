// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  signFsUploadToken,
  verifyFsUploadToken,
  type FsUploadTokenPayload,
} from "@appstrate/core/storage-fs";

const SECRET = "test-secret-0123456789";

function future(): number {
  return Math.floor(Date.now() / 1000) + 300;
}

describe("FS upload token", () => {
  it("round-trips a valid payload", () => {
    const payload: FsUploadTokenPayload = {
      k: "uploads/app_x/upl_y/doc.pdf",
      s: 1024,
      m: "application/pdf",
      e: future(),
    };
    const token = signFsUploadToken(payload, SECRET);
    const verified = verifyFsUploadToken(token, SECRET);
    expect(verified).toEqual(payload);
  });

  it("rejects a tampered body", () => {
    const token = signFsUploadToken({ k: "uploads/a/b", s: 0, m: "", e: future() }, SECRET);
    // Flip a character in the base64url body portion
    const [body, sig] = token.split(".");
    const swapped = body!.slice(0, -1) + (body!.endsWith("A") ? "B" : "A");
    expect(verifyFsUploadToken(`${swapped}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a bad signature", () => {
    const token = signFsUploadToken({ k: "uploads/a/b", s: 0, m: "", e: future() }, SECRET);
    expect(verifyFsUploadToken(token, "different-secret")).toBeNull();
  });

  it("rejects an expired token", () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    const token = signFsUploadToken({ k: "uploads/a/b", s: 0, m: "", e: past }, SECRET);
    expect(verifyFsUploadToken(token, SECRET)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyFsUploadToken("not-a-token", SECRET)).toBeNull();
    expect(verifyFsUploadToken("", SECRET)).toBeNull();
    expect(verifyFsUploadToken(".justsig", SECRET)).toBeNull();
  });
});
