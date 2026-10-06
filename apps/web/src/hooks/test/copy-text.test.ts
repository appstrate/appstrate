// SPDX-License-Identifier: Apache-2.0

/**
 * A copy the browser refuses must say so: the button otherwise looks like it
 * worked, and the user pastes whatever the clipboard held before.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { toast } from "sonner";
import { copyText } from "../use-copy-to-clipboard.ts";

const setClipboard = (clipboard: unknown) =>
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true });

describe("copyText", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let toastError: Mock<typeof toast.error>;

  beforeEach(() => {
    toastError = spyOn(toast, "error").mockImplementation(() => "");
  });
  afterEach(() => {
    toastError.mockRestore();
    if (original) Object.defineProperty(globalThis, "navigator", original);
  });

  it("copies silently when the browser allows it", async () => {
    const written: string[] = [];
    setClipboard({ writeText: async (text: string) => void written.push(text) });

    expect(await copyText("https://app.test/invite/tok")).toBe(true);
    expect(written).toEqual(["https://app.test/invite/tok"]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reports a denied permission", async () => {
    setClipboard({
      writeText: async () => {
        throw new DOMException("Write permission denied.", "NotAllowedError");
      },
    });

    expect(await copyText("x")).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("reports a context with no clipboard at all", async () => {
    setClipboard(undefined);

    expect(await copyText("x")).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
