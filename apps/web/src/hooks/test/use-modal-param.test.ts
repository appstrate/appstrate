// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { modalParamStep } from "../use-modal-param.ts";

const at = (search: string, state: unknown = null) => ({ search, state });

describe("modal open state in the URL", () => {
  it("pushes the opening, marking the entry as that modal's", () => {
    expect(modalParamStep(at("?tab=a", { selectedDay: "d" }), "editModel", "m_1")).toEqual({
      back: false,
      search: "?tab=a&editModel=m_1",
      replace: false,
      state: { selectedDay: "d", openedModal: "editModel" },
    });
  });

  it("closes a modal it pushed by going back over its entry", () => {
    expect(
      modalParamStep(at("?editModel=m_1", { openedModal: "editModel" }), "editModel", null),
    ).toEqual({ back: true });
  });

  it("replaces on close when the address opened the modal", () => {
    expect(modalParamStep(at("?tab=a&editModel=m_1"), "editModel", null)).toEqual({
      back: false,
      search: "?tab=a",
      replace: true,
      state: null,
    });
  });

  it("changes an open modal's value in place, keeping its entry's mark", () => {
    expect(
      modalParamStep(at("?editModel=m_1", { openedModal: "editModel" }), "editModel", "m_2"),
    ).toEqual({
      back: false,
      search: "?editModel=m_2",
      replace: true,
      state: { openedModal: "editModel" },
    });
  });

  it("hands over in place: the next modal closes back over the first one's entry", () => {
    const pushed = modalParamStep(
      at("?newSchedule=1", { openedModal: "newSchedule" }),
      "connect",
      "gmail",
      "newSchedule",
    );
    expect(pushed).toEqual({
      back: false,
      search: "?connect=gmail",
      replace: true,
      state: { openedModal: "connect" },
    });
    // Handed over from a modal the address opened, it has no entry of its own either.
    const cold = modalParamStep(at("?newSchedule=1"), "connect", "gmail", "newSchedule");
    expect(cold).toEqual({ back: false, search: "?connect=gmail", replace: true, state: {} });
  });
});
