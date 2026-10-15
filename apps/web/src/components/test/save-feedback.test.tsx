// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { SaveFeedback } from "../settings/save-feedback.tsx";
import { fieldWriteState } from "../../lib/field-write-state.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

describe("SaveFeedback", () => {
  it("says what the write did, one line at a time", () => {
    expect(render(<SaveFeedback pending success={false} error={false} />)).toContain(
      "Enregistrement…",
    );
    expect(render(<SaveFeedback pending={false} success error={false} />)).toContain("Enregistré");
    expect(render(<SaveFeedback pending={false} success={false} error />)).toContain(
      "Erreur d’enregistrement",
    );
  });

  it("keeps its height when it has nothing to say, so the page does not jump", () => {
    const html = render(<SaveFeedback pending={false} success={false} error={false} />);
    expect(html).toContain("min-h-5");
    expect(html).not.toContain("Enregistr");
  });
});

describe("fieldWriteState", () => {
  // One PATCH writes several settings; each row reads the write that carried its own key.
  const write = (body: object, state: "pending" | "success" | "error") => ({
    isPending: state === "pending",
    isSuccess: state === "success",
    isError: state === "error",
    variables: { body },
  });

  it("reports a write to the field its body carried", () => {
    expect(fieldWriteState(write({ name: "Acme" }, "success"), "name")).toEqual({
      pending: false,
      success: true,
      error: false,
    });
    expect(fieldWriteState(write({ settings: {} }, "error"), "settings").error).toBe(true);
  });

  it("says nothing under another field, nor before any write", () => {
    const quiet = { pending: false, success: false, error: false };
    expect(fieldWriteState(write({ name: "Acme" }, "pending"), "visibility")).toEqual(quiet);
    expect(fieldWriteState({ isPending: false, isSuccess: false, isError: false }, "name")).toEqual(
      quiet,
    );
  });
});
