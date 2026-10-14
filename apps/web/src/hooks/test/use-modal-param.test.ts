// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createMemoryRouter, resolvePath } from "react-router-dom";
import { closeOncePerEntry, modalLeaveSteps, modalParamStep } from "../use-modal-param.ts";

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

describe("leaving a modal for where its act took the user", () => {
  const page = (search: string, state: unknown = null) => ({
    pathname: "/integrations/@appstrate/slack",
    search,
    hash: "#settings",
    state,
  });
  const copy = resolvePath("/integrations/@acme/slack");

  it("puts the destination in the entry the opening pushed", () => {
    expect(modalLeaveSteps(page("?fork=1", { openedModal: "fork" }), "fork", copy)).toEqual([
      {
        to: { pathname: "/integrations/@acme/slack", search: "", hash: "" },
        replace: true,
        state: undefined,
      },
    ]);
  });

  it("closes a modal the address opened in place, then pushes the destination", () => {
    expect(modalLeaveSteps(page("?tab=a&fork=1"), "fork", copy, { draft: "x" })).toEqual([
      {
        to: { pathname: "/integrations/@appstrate/slack", search: "?tab=a", hash: "#settings" },
        replace: true,
        state: null,
      },
      {
        to: { pathname: "/integrations/@acme/slack", search: "", hash: "" },
        replace: false,
        state: { draft: "x" },
      },
    ]);
  });

  it("never carries the modal's parameter to the destination", () => {
    const steps = modalLeaveSteps(
      page("?package=p_1", { openedModal: "package" }),
      "package",
      resolvePath("/catalogue/discover/skill?q=mail&package=p_1"),
    );
    expect(steps.map((step) => step.to.search)).toEqual(["?q=mail"]);
  });

  it("replaces the current entry when the modal is not open", () => {
    expect(modalLeaveSteps(page("?q=mail"), "package", copy)).toEqual([
      {
        to: { pathname: "/integrations/@acme/slack", search: "", hash: "" },
        replace: true,
        state: undefined,
      },
    ]);
  });
});

describe("leaving a modal, in a router's history", () => {
  /** Applies each navigation the way `useModalParam` does. */
  async function follow(
    router: ReturnType<typeof createMemoryRouter>,
    steps: { to: Parameters<typeof router.navigate>[0]; replace: boolean; state?: unknown }[],
  ) {
    for (const step of steps) {
      await router.navigate(step.to, { replace: step.replace, state: step.state });
    }
  }

  async function openFork(router: ReturnType<typeof createMemoryRouter>) {
    const { location } = router.state;
    const step = modalParamStep(location, "fork", "1");
    if (step.back) throw new Error("an opening never goes back");
    await follow(router, [
      {
        to: { pathname: location.pathname, search: step.search },
        replace: step.replace,
        state: step.state,
      },
    ]);
  }

  const leaveFork = (router: ReturnType<typeof createMemoryRouter>) =>
    follow(
      router,
      modalLeaveSteps(router.state.location, "fork", resolvePath("/integrations/@acme/slack")),
    );

  const where = (router: ReturnType<typeof createMemoryRouter>) =>
    router.state.location.pathname + router.state.location.search;

  it("lands on the destination; Back returns to the page under the modal, closed", async () => {
    const router = createMemoryRouter([{ path: "*" }], {
      initialEntries: ["/integrations", "/integrations/@appstrate/slack"],
      initialIndex: 1,
    });
    await openFork(router);
    expect(where(router)).toBe("/integrations/@appstrate/slack?fork=1");
    await leaveFork(router);
    expect(where(router)).toBe("/integrations/@acme/slack");
    await router.navigate(-1);
    expect(where(router)).toBe("/integrations/@appstrate/slack");
    await router.navigate(-1);
    expect(where(router)).toBe("/integrations");
  });

  it("from a modal the address opened, Back still returns to the page, closed", async () => {
    const router = createMemoryRouter([{ path: "*" }], {
      initialEntries: ["/integrations/@appstrate/slack?fork=1"],
    });
    await leaveFork(router);
    expect(where(router)).toBe("/integrations/@acme/slack");
    await router.navigate(-1);
    expect(where(router)).toBe("/integrations/@appstrate/slack");
  });
});

describe("closing a modal twice from one entry", () => {
  type Router = ReturnType<typeof createMemoryRouter>;
  const where = (router: Router) => router.state.location.pathname + router.state.location.search;

  /**
   * Closes the way `useModalParam` does, from the location a render read: going
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
