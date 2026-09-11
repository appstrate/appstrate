// SPDX-License-Identifier: Apache-2.0

/**
 * Pins `lib/keyring.ts`'s error marker against the `@napi-rs/keyring`
 * native binary this checkout actually installs.
 *
 * Why this test exists: the marker is the only discriminator we get.
 * `@napi-rs/keyring` surfaces `keyring-core` errors as plain JS `Error`s
 * — no variant, no `code`, nothing but the Display string — and that
 * string decides whether a keyring failure means "this host has no
 * store, use the 0600 file" or "the store is locked, refuse to write
 * plaintext". The 2.0 bump (#1299) reworded every one of them and no
 * call site noticed, so a store-less CI runner started hard-refusing
 * instead of falling back (#1321). A matcher over an upstream message
 * that nothing verifies is a silent time bomb; reading the shipped
 * binary turns the next rewording into a red test.
 *
 * The binary is read as BYTES and never loaded: `new Entry(...)` on a
 * daemon-less Linux runner segfaults the process (see the note on
 * `_isKeyringFactoryOverriddenForTesting` in `lib/keyring.ts`), which
 * no test can catch.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { dirname } from "node:path";
import { PLATFORM_FAILURE_MARKER } from "../src/lib/keyring.ts";

/**
 * Platform packages `@napi-rs/keyring` may have installed here. Linux
 * lists both libc flavours rather than sniffing which one is running —
 * exactly one of them is present, and trying both is cheaper than
 * getting musl detection wrong.
 */
function candidatePackages(): string[] {
  const arch = process.arch;
  switch (process.platform) {
    case "darwin":
      return [`@napi-rs/keyring-darwin-${arch}`];
    case "win32":
      return [`@napi-rs/keyring-win32-${arch}-msvc`];
    case "linux":
      return [`@napi-rs/keyring-linux-${arch}-gnu`, `@napi-rs/keyring-linux-${arch}-musl`];
    default:
      return [`@napi-rs/keyring-${process.platform}-${arch}`];
  }
}

/**
 * The platform package is an optional dependency of `@napi-rs/keyring`,
 * so under bun's isolated layout it is only reachable FROM the keyring
 * package's own directory — not from this workspace. Resolve in two
 * steps for that reason. Its `main` is the `.node` file itself, so the
 * resolved path is the binary.
 */
function nativeBindingPath(): string {
  const keyringDir = dirname(Bun.resolveSync("@napi-rs/keyring", import.meta.dir));
  const tried: string[] = [];
  for (const pkg of candidatePackages()) {
    try {
      return Bun.resolveSync(pkg, keyringDir);
    } catch {
      tried.push(pkg);
    }
  }
  throw new Error(
    `No @napi-rs/keyring native package installed for ${process.platform}-${process.arch} (tried: ${tried.join(", ")}). ` +
      `The CLI cannot store credentials without it.`,
  );
}

describe("@napi-rs/keyring error markers", () => {
  let binary: Buffer;

  beforeAll(async () => {
    binary = Buffer.from(await Bun.file(nativeBindingPath()).bytes());
  });

  it("still emits the Display prefix the classifier splits on", () => {
    expect(binary.includes(PLATFORM_FAILURE_MARKER, 0, "utf8")).toBe(true);
  });
});
