// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { UNSAFE_createBrowserHistory, type Location } from "react-router-dom";
import {
  backgroundOf,
  historyIndexOf,
  isPage,
  modalReturnTarget,
  orgSwitchLanding,
  overlayCloseStep,
  pageLocation,
  withBackground,
} from "../modal-route";

const at = (pathname: string, rest: Partial<Location> = {}): Location => ({
  pathname,
  search: "",
  hash: "",
  state: null,
  key: pathname,
  ...rest,
});

describe("page under an overlay", () => {
  const runs = at("/runs", { search: "?status=failed", hash: "#run-42" });

  it("renders a page as itself, whatever came before", () => {
    const agents = at("/agents");
    expect(pageLocation(agents, runs)).toBe(agents);
    expect(pageLocation(agents, null)).toBe(agents);
  });

  it("keeps the last page under every overlay path, without any history state", () => {
    for (const path of [
      "/org-settings",
      "/org-settings/models",
      "/workspace-settings/webhooks/wh_1",
      "/preferences/general",
      "/catalogue/discover/agent",
    ]) {
      expect(pageLocation(at(path), runs)).toBe(runs);
    }
  });

  it("puts the dashboard under an overlay the app opened on", () => {
    expect(pageLocation(at("/org-settings/general"), null)).toMatchObject({
      pathname: "/",
      search: "",
      hash: "",
      state: null,
    });
  });

  it("treats a lookalike prefix as a page", () => {
    const lookalike = at("/catalogueX");
    expect(pageLocation(lookalike, runs)).toBe(lookalike);
  });
});

describe("what an overlay may float over", () => {
  it("remembers the shell's screens", () => {
    for (const path of ["/", "/agents", "/agents/@acme/triage/runs/run_1", "/chat/c_1", "/files"]) {
      expect(isPage(path)).toBe(true);
    }
  });

  it("never remembers an overlay or a hand-off whose redirect would fire again underneath", () => {
    for (const path of [
      "/org-settings/general",
      "/catalogue",
      "/login",
      "/auth/callback",
      "/invite/tok",
      "/welcome",
      "/onboarding/create",
    ]) {
      expect(isPage(path)).toBe(false);
    }
  });
});

describe("routed modal return target", () => {
  it("restores the complete background URL and router state", () => {
    const background = at("/runs", {
      search: "?status=failed",
      hash: "#run-42",
      state: { selectedDay: "2026-08-23" },
    });

    expect(modalReturnTarget(background)).toEqual({
      to: {
        pathname: "/runs",
        search: "?status=failed",
        hash: "#run-42",
      },
      state: { selectedDay: "2026-08-23" },
    });
  });

  it("returns to the dashboard without a background", () => {
    expect(modalReturnTarget(null)).toEqual({
      to: { pathname: "/", search: "", hash: "" },
      state: null,
    });
  });
});

describe("closing an overlay", () => {
  it("goes back to the page it was opened from, past the pages opened inside it", () => {
    // /agents (3) → /org-settings/general (4) → /org-settings/members (5).
    expect(overlayCloseStep(3, 4)).toBe(-1);
    expect(overlayCloseStep(3, 5)).toBe(-2);
  });

  it("replaces when the background has no entry behind the overlay", () => {
    // A pasted link or a reload: the dashboard stands in, with no entry.
    expect(overlayCloseStep(null, 0)).toBeNull();
    // The page under it was swapped by an organization switch.
    expect(overlayCloseStep(null, 4)).toBeNull();
    expect(overlayCloseStep(4, 4)).toBeNull();
    expect(overlayCloseStep(3, null)).toBeNull();
  });
});

describe("organization switch", () => {
  it("lands the page on its product's root, whatever resource it named", () => {
    expect(orgSwitchLanding("/agents/@acme/triage/runs/run_1")).toBe("/");
    expect(orgSwitchLanding("/")).toBe("/");
    expect(orgSwitchLanding("/chat/c_1")).toBe("/chat");
    expect(orgSwitchLanding("/chat")).toBe("/chat");
    expect(orgSwitchLanding("/chatroom")).toBe("/");
  });
});

describe("the history index React Router keeps", () => {
  /** The browser `window` the router's history drives, reduced to what it touches. */
  function fakeWindow() {
    const entries: { state: unknown; url: string }[] = [{ state: null, url: "/" }];
    let at = 0;
    const location = { origin: "http://app.test", pathname: "/", search: "", hash: "" };
    const move = (url: string) => {
      const parsed = new URL(url, location.origin);
      location.pathname = parsed.pathname;
      location.search = parsed.search;
      location.hash = parsed.hash;
    };
    const history = {
      get state() {
        return entries[at]!.state;
      },
      get length() {
        return entries.length;
      },
      pushState(state: unknown, _title: string, url: string) {
        entries.splice(at + 1, entries.length, { state, url });
        at += 1;
        move(url);
      },
      replaceState(state: unknown, _title: string, url?: string) {
        entries[at] = { state, url: url ?? entries[at]!.url };
        if (url) move(url);
      },
      go() {},
    };
    return {
      location: Object.assign(location, {
        get href() {
          return `${location.origin}${location.pathname}${location.search}${location.hash}`;
        },
      }),
      history,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Window;
  }

  // The overlay's close reads it: when this fails, React Router stopped
  // numbering its entries in `idx`, and every close falls back to replacing.
  it("numbers each entry of the browser history, in the entry's state", () => {
    const window = fakeWindow();
    const history = UNSAFE_createBrowserHistory({ window });
    expect(historyIndexOf(window.history.state)).toBe(0);
    history.push("/agents");
    history.push("/catalogue/discover/agent");
    expect(historyIndexOf(window.history.state)).toBe(2);
    history.replace("/catalogue/discover/skill");
    expect(historyIndexOf(window.history.state)).toBe(2);
  });

  it("reads no index from a state that has none", () => {
    expect(historyIndexOf(null)).toBeNull();
    expect(historyIndexOf({ idx: "2" })).toBeNull();
    expect(historyIndexOf({ usr: null })).toBeNull();
  });
});

describe("the background an overlay entry holds", () => {
  const agents = at("/agents", { search: "?q=tri", hash: "#top", state: { tab: "mine" } });

  it("survives a reload: the entry's state names the page and its history entry", () => {
    // What a reload reads back is what the entry was given, cloned.
    const state = structuredClone(
      withBackground({ openedModal: "package" }, { location: agents, index: 3 }),
    );
    const held = backgroundOf(state);
    expect(held).toEqual({ location: agents, index: 3 });
    // The reloaded overlay floats over that page, and closing goes back to it.
    expect(pageLocation(at("/catalogue/discover/agent"), held!.location)).toEqual(agents);
    expect(overlayCloseStep(held!.index, 4)).toBe(-1);
  });

  it("keeps the rest of the entry's state", () => {
    const state = withBackground({ openedModal: "package" }, { location: agents, index: null });
    expect(state).toMatchObject({ openedModal: "package" });
    expect(backgroundOf(state)?.index).toBeNull();
  });

  it("finds none in a state that holds none", () => {
    expect(backgroundOf(null)).toBeNull();
    expect(backgroundOf({ openedModal: "package" })).toBeNull();
    expect(backgroundOf({ overlayBackground: { index: 1 } })).toBeNull();
  });
});
