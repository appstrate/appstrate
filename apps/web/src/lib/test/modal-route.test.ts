// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { Location } from "react-router-dom";
import { isPage, modalReturnTarget, pageLocation } from "../modal-route";

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
