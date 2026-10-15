// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createMemoryRouter } from "react-router-dom";
import { closeOncePerEntry, modalOpeningState, modalParamStep } from "../use-url-modal.ts";

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
});

describe("a parameter that qualifies the modal's value", () => {
  const companions = ["version"];

  it("goes when the modal closes", () => {
    expect(
      modalParamStep(at("?q=mail&package=p_1&version=1.2.0"), "package", null, companions),
    ).toEqual({ back: false, search: "?q=mail", replace: true, state: null });
  });

  it("goes when the modal names another object", () => {
    expect(
      modalParamStep(
        at("?package=p_1&version=1.2.0", { openedModal: "package" }),
        "package",
        "p_2",
        companions,
      ),
    ).toEqual({
      back: false,
      search: "?package=p_2",
      replace: true,
      state: { openedModal: "package" },
    });
  });

  it("stays when the modal is set to the value it already has", () => {
    expect(
      modalParamStep(at("?package=p_1&version=1.2.0"), "package", "p_1", companions),
    ).toMatchObject({ search: "?package=p_1&version=1.2.0" });
  });

  it("is left alone by a modal that declares none", () => {
    expect(modalParamStep(at("?package=p_1&version=1.2.0"), "package", null)).toEqual({
      back: false,
      search: "?version=1.2.0",
      replace: true,
      state: null,
    });
  });
});

describe("closing a modal twice from one entry", () => {
  type Router = ReturnType<typeof createMemoryRouter>;
  const where = (router: Router) => router.state.location.pathname + router.state.location.search;

  /**
   * Closes the way `useUrlModal` does, from the location a render read: going
   * back is not awaited, as the hook's `navigate(-1)` is not.
   */
  function close(
    router: Router,
    location: Router["state"]["location"],
    guard: ReturnType<typeof closeOncePerEntry>,
  ) {
    if (!guard.take(location.key)) return Promise.resolve();
    const step = modalParamStep(location, "field-input", null);
    if (step.back) return router.navigate(-1);
    return router.navigate(
      { pathname: location.pathname, search: step.search },
      { replace: step.replace, state: step.state },
    );
  }

  it("goes back once when an Apply renames the target and the old name then drops", async () => {
    const router = createMemoryRouter([{ path: "*" }], {
      initialEntries: ["/agents", "/agents/@acme/a"],
      initialIndex: 1,
    });
    const opening = modalParamStep(router.state.location, "field-input", "old_key");
    if (opening.back) throw new Error("an opening never goes back");
    await router.navigate(
      { pathname: router.state.location.pathname, search: opening.search },
      { replace: opening.replace, state: opening.state },
    );
    expect(where(router)).toBe("/agents/@acme/a?field-input=old_key");

    // Apply closes, and the same render, still on `old_key`, finds no field by
    // that name and closes again.
    const guard = closeOncePerEntry();
    const rendered = router.state.location;
    await Promise.all([close(router, rendered, guard), close(router, rendered, guard)]);
    expect(where(router)).toBe("/agents/@acme/a");
  });

  it("still closes from the next entry", () => {
    const guard = closeOncePerEntry();
    expect(guard.take("a")).toBe(true);
    expect(guard.take("a")).toBe(false);
    expect(guard.take("b")).toBe(true);
  });

  it("closes again from an entry reached anew once the location has moved", () => {
    const guard = closeOncePerEntry();
    expect(guard.take("a")).toBe(true);
    guard.release();
    expect(guard.take("a")).toBe(true);
  });
});

describe("opening a modal on another address", () => {
  it("closes it the way Back does, to the list it was opened from", async () => {
    // A link from another page opens a package's sheet on a list of another kind.
    const router = createMemoryRouter([{ path: "*" }], {
      initialEntries: ["/catalogue/agent"],
    });
    const from = router.state.location;
    await router.navigate("/catalogue/skill?package=%40acme%2Fnotes", {
      state: modalOpeningState(from.state, "package"),
    });
    const { location } = router.state;
    expect(modalParamStep(location, "package", null)).toEqual({ back: true });
    await router.navigate(-1);
    expect(router.state.location.pathname).toBe("/catalogue/agent");
  });

  it("keeps the entry's other state", () => {
    expect(modalOpeningState({ overlayBackground: { index: 2 } }, "package")).toEqual({
      overlayBackground: { index: 2 },
      openedModal: "package",
    });
  });
});
