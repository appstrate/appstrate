// SPDX-License-Identifier: Apache-2.0

/**
 * The api_call / api_upload pair is toggled as one unit in the picker, because
 * the runtime grants both from either name (upload chunks are dispatched
 * through the sibling api_call tool). These assert the write-back the editor
 * puts into `integrations_configuration.<id>.tools`.
 */

import { describe, it, expect } from "bun:test";
import { API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME } from "@appstrate/core/integration";
import {
  isApiCallToolSelectionEnabled,
  replaceNativeToolSelection,
  toggleApiCallToolSelection,
} from "../tool-selection.ts";

describe("toggleApiCallToolSelection", () => {
  const SYNTHETIC_UPLOAD = new Set([API_UPLOAD_TOOL_NAME]);
  const NO_SYNTHETIC_UPLOAD = new Set<string>();

  it("adds the pair when the catalog exposes the companion", () => {
    expect(toggleApiCallToolSelection(["kv_set"], API_CALL_TOOL_NAME, SYNTHETIC_UPLOAD)).toEqual([
      "kv_set",
      API_CALL_TOOL_NAME,
      API_UPLOAD_TOOL_NAME,
    ]);
  });

  it("adds api_call alone when the catalog has no companion", () => {
    expect(toggleApiCallToolSelection([], API_CALL_TOOL_NAME, NO_SYNTHETIC_UPLOAD)).toEqual([
      API_CALL_TOOL_NAME,
    ]);
  });

  it("removes the pair on the second toggle, leaving native tools untouched", () => {
    const on = toggleApiCallToolSelection(["kv_set"], API_CALL_TOOL_NAME, SYNTHETIC_UPLOAD);
    expect(toggleApiCallToolSelection(on, API_CALL_TOOL_NAME, SYNTHETIC_UPLOAD)).toEqual([
      "kv_set",
    ]);
  });

  it("revokes the effective pair from an upload-only half-selection", () => {
    // The resolver grants both tools from `api_upload` alone. The UI therefore
    // treats this legacy/hand-edited state as ON, and the next toggle is OFF.
    expect(
      toggleApiCallToolSelection([API_UPLOAD_TOOL_NAME], API_CALL_TOOL_NAME, SYNTHETIC_UPLOAD),
    ).toEqual([]);
  });

  it("reports an upload-only half-selection as effectively enabled", () => {
    expect(
      isApiCallToolSelectionEnabled(
        new Set([API_UPLOAD_TOOL_NAME]),
        API_CALL_TOOL_NAME,
        SYNTHETIC_UPLOAD,
      ),
    ).toBe(true);
    expect(
      isApiCallToolSelectionEnabled(new Set(["kv_set"]), API_CALL_TOOL_NAME, SYNTHETIC_UPLOAD),
    ).toBe(false);
  });

  it("is idempotent in the off direction (removing an absent pair is a no-op)", () => {
    expect(toggleApiCallToolSelection(["kv_set"], API_CALL_TOOL_NAME, SYNTHETIC_UPLOAD)).toEqual([
      "kv_set",
      API_CALL_TOOL_NAME,
      API_UPLOAD_TOOL_NAME,
    ]);
    expect(toggleApiCallToolSelection([], API_CALL_TOOL_NAME, NO_SYNTHETIC_UPLOAD)).toEqual([
      API_CALL_TOOL_NAME,
    ]);
  });

  it("pairs the per-auth variants with their matching companion", () => {
    const syntheticUploads = new Set(["api_upload__primary"]);
    expect(toggleApiCallToolSelection([], "api_call__primary", syntheticUploads)).toEqual([
      "api_call__primary",
      "api_upload__primary",
    ]);
    expect(toggleApiCallToolSelection([], "api_call__backup", syntheticUploads)).toEqual([
      "api_call__backup",
    ]);
  });

  it("never invents a companion the catalog doesn't list", () => {
    expect(toggleApiCallToolSelection([], API_CALL_TOOL_NAME, NO_SYNTHETIC_UPLOAD)).toEqual([
      API_CALL_TOOL_NAME,
    ]);
  });

  it("does not grant a same-named native api_upload without a synthetic companion", () => {
    // The full catalog may contain a native `api_upload`; callers pass only
    // capability-derived companions, so it must remain independently gated.
    expect(toggleApiCallToolSelection([], API_CALL_TOOL_NAME, NO_SYNTHETIC_UPLOAD)).toEqual([
      API_CALL_TOOL_NAME,
    ]);
  });

  it("does not add an api_upload companion hidden from the effective catalog", () => {
    expect(toggleApiCallToolSelection([], API_CALL_TOOL_NAME, NO_SYNTHETIC_UPLOAD)).toEqual([
      API_CALL_TOOL_NAME,
    ]);
  });

  it("bulk native selection preserves the independently selected API pair", () => {
    const selection = [API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME, "kv_get"];
    const native = ["kv_get", "kv_set"];
    const visibleSynthetic = new Set([API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME]);
    expect(replaceNativeToolSelection(selection, native, visibleSynthetic, true)).toEqual([
      API_CALL_TOOL_NAME,
      API_UPLOAD_TOOL_NAME,
      "kv_get",
      "kv_set",
    ]);
    expect(replaceNativeToolSelection(selection, native, visibleSynthetic, false)).toEqual([
      API_CALL_TOOL_NAME,
      API_UPLOAD_TOOL_NAME,
    ]);
  });

  it("bulk native selection drops unknown and stale synthetic names", () => {
    const selection = [
      API_CALL_TOOL_NAME,
      API_UPLOAD_TOOL_NAME,
      "api_call__removed_auth",
      "removed_native_tool",
      "kv_get",
    ];
    const native = ["kv_get", "kv_set"];
    const visibleSynthetic = new Set([API_CALL_TOOL_NAME]);

    expect(replaceNativeToolSelection(selection, native, visibleSynthetic, true)).toEqual([
      API_CALL_TOOL_NAME,
      "kv_get",
      "kv_set",
    ]);
    expect(replaceNativeToolSelection(selection, native, visibleSynthetic, false)).toEqual([
      API_CALL_TOOL_NAME,
    ]);
  });
});
