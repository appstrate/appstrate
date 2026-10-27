// SPDX-License-Identifier: Apache-2.0

/**
 * The Artifact frame's "copy": a file read that fails and a clipboard the
 * browser refuses are two different failures, said by two different messages —
 * the clipboard's through `useCopyToClipboard`, like every copy in the app.
 *
 * No DOM: a probe captures the hook during a static render, the typed client's
 * GET is stubbed, and the copy is driven by hand.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import { toast } from "sonner";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { client } = await import("../../api/client.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");
const { useFileTextCopy } = await import("../use-files.ts");
const { TranslatedUiLabels } = await import("../../components/translated-ui-labels.tsx");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");
const t = i18nModule.default.t.bind(i18nModule.default);

function fileTextCopy() {
  const captured: ReturnType<typeof useFileTextCopy>[] = [];
  function Probe() {
    captured.push(useFileTextCopy());
    return null;
  }
  render(
    <TranslatedUiLabels>
      <Probe />
    </TranslatedUiLabels>,
  );
  return captured[0]!;
}

const setClipboard = (clipboard: unknown) =>
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true });

describe("useFileTextCopy", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let toastError: Mock<typeof toast.error>;
  let get: ReturnType<typeof spyOn>;

  beforeEach(() => {
    toastError = spyOn(toast, "error").mockImplementation(() => "");
    get = spyOn(client, "GET");
  });
  afterEach(() => {
    toastError.mockRestore();
    get.mockRestore();
    if (original) Object.defineProperty(globalThis, "navigator", original);
  });

  it("copies the file's text", async () => {
    const written: string[] = [];
    setClipboard({ writeText: async (text: string) => void written.push(text) });
    get.mockResolvedValue({ data: "# Rapport" });
    await fileTextCopy().copy("file_1");
    expect(written).toEqual(["# Rapport"]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says the clipboard refused, not that the file could not be read", async () => {
    setClipboard(undefined);
    get.mockResolvedValue({ data: "# Rapport" });
    await fileTextCopy().copy("file_1");
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]?.[0]).toBe(t("common:error.copyFailed"));
  });

  it("says the file could not be read, without touching the clipboard", async () => {
    const written: string[] = [];
    setClipboard({ writeText: async (text: string) => void written.push(text) });
    get.mockRejectedValue(new Error("network"));
    await fileTextCopy().copy("file_1");
    expect(written).toEqual([]);
    expect(toastError.mock.calls[0]?.[0]).toBe(t("files:artifact.copyFailed"));
  });
});
