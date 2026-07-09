// SPDX-License-Identifier: Apache-2.0

/**
 * The api_call / api_upload pair is toggled as one unit in the picker, because
 * the runtime grants both from either name (upload chunks are dispatched
 * through the sibling api_call tool). These assert the write-back the editor
 * puts into `integrations_configuration.<id>.tools`.
 */

import { describe, it, expect } from "bun:test";
import { API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME } from "@appstrate/core/integration";
import { toggleApiCallToolSelection } from "../tool-selection.ts";

describe("toggleApiCallToolSelection", () => {
  const CATALOG_WITH_UPLOAD = ["kv_set", API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME];
  const CATALOG_NO_UPLOAD = ["kv_set", API_CALL_TOOL_NAME];

  it("adds the pair when the catalog exposes the companion", () => {
    expect(toggleApiCallToolSelection(["kv_set"], API_CALL_TOOL_NAME, CATALOG_WITH_UPLOAD)).toEqual(
      ["kv_set", API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME],
    );
  });

  it("adds api_call alone when the catalog has no companion", () => {
    expect(toggleApiCallToolSelection([], API_CALL_TOOL_NAME, CATALOG_NO_UPLOAD)).toEqual([
      API_CALL_TOOL_NAME,
    ]);
  });

  it("removes the pair on the second toggle, leaving native tools untouched", () => {
    const on = toggleApiCallToolSelection(["kv_set"], API_CALL_TOOL_NAME, CATALOG_WITH_UPLOAD);
    expect(toggleApiCallToolSelection(on, API_CALL_TOOL_NAME, CATALOG_WITH_UPLOAD)).toEqual([
      "kv_set",
    ]);
  });

  it("completes a half-selection without duplicating the companion", () => {
    // `api_call` absent, `api_upload` present (a hand-edited manifest) → the
    // toggle turns the pair ON and must not repeat the companion.
    expect(
      toggleApiCallToolSelection([API_UPLOAD_TOOL_NAME], API_CALL_TOOL_NAME, CATALOG_WITH_UPLOAD),
    ).toEqual([API_UPLOAD_TOOL_NAME, API_CALL_TOOL_NAME]);
  });

  it("is idempotent in the off direction (removing an absent pair is a no-op)", () => {
    expect(toggleApiCallToolSelection(["kv_set"], API_CALL_TOOL_NAME, CATALOG_WITH_UPLOAD)).toEqual(
      ["kv_set", API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME],
    );
    expect(toggleApiCallToolSelection([], API_CALL_TOOL_NAME, [])).toEqual([API_CALL_TOOL_NAME]);
  });

  it("pairs the per-auth variants with their matching companion", () => {
    const catalog = ["api_call__primary", "api_upload__primary", "api_call__backup"];
    expect(toggleApiCallToolSelection([], "api_call__primary", catalog)).toEqual([
      "api_call__primary",
      "api_upload__primary",
    ]);
    expect(toggleApiCallToolSelection([], "api_call__backup", catalog)).toEqual([
      "api_call__backup",
    ]);
  });

  it("never invents a companion the catalog doesn't list", () => {
    expect(toggleApiCallToolSelection([], API_CALL_TOOL_NAME, ["kv_set"])).toEqual([
      API_CALL_TOOL_NAME,
    ]);
  });
});
