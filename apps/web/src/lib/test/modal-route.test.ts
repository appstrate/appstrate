// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { Location } from "react-router-dom";
import { modalReturnTarget } from "../modal-route";

describe("routed modal return target", () => {
  it("restores the complete background URL and router state", () => {
    const background = {
      pathname: "/runs",
      search: "?status=failed",
      hash: "#run-42",
      state: { selectedDay: "2026-08-23" },
      key: "background",
    } satisfies Location;

    expect(modalReturnTarget(background)).toEqual({
      to: {
        pathname: "/runs",
        search: "?status=failed",
        hash: "#run-42",
      },
      state: { selectedDay: "2026-08-23" },
    });
  });

  it("returns to the dashboard for a cold settings URL", () => {
    expect(modalReturnTarget(null)).toEqual({
      to: { pathname: "/", search: "", hash: "" },
      state: null,
    });
  });
});
