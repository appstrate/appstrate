// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import {
  acquireDesktopOriginLease,
  assertTabBudget,
  clearDesktopLeases,
  forgetDesktopTab,
  handleDesktopTabNotification,
  listDesktopTabsForRun,
  MAX_TABS_PER_RUN,
  MAX_TABS_PER_USER,
  noteDesktopTabOrigin,
  recordDesktopExposure,
  registerDesktopTab,
  releaseDesktopLeaseByRun,
  requireDesktopTab,
  DesktopExposureConflictError,
  DesktopLeaseConflictError,
  DesktopTabGoneError,
  DesktopTabPausedError,
  DesktopTabQuotaError,
} from "../../lease.ts";

const AGENT_A = "persist:appstrate-agent-tractr-a";
const AGENT_B = "persist:appstrate-agent-tractr-b";

afterEach(() => clearDesktopLeases());

describe("desktop tab leases", () => {
  it("lets two runs drive their own tabs at the same time", () => {
    registerDesktopTab("u1", "r1", "tab_1", AGENT_A);
    registerDesktopTab("u1", "r2", "tab_2", AGENT_B);

    expect(requireDesktopTab("u1", "r1", "tab_1").tabId).toBe("tab_1");
    expect(requireDesktopTab("u1", "r2", "tab_2").tabId).toBe("tab_2");
  });

  it("refuses a tab owned by another run", () => {
    registerDesktopTab("u1", "r1", "tab_1", AGENT_A);
    expect(() => requireDesktopTab("u1", "r2", "tab_1")).toThrow(DesktopLeaseConflictError);
  });

  it("reports a closed tab as gone", () => {
    registerDesktopTab("u1", "r1", "tab_1", AGENT_A);
    forgetDesktopTab("u1", "tab_1");
    expect(() => requireDesktopTab("u1", "r1", "tab_1")).toThrow(DesktopTabGoneError);
  });

  it("blocks the owning run while the user holds the tab", () => {
    registerDesktopTab("u1", "r1", "tab_1", AGENT_A);
    handleDesktopTabNotification("u1", "tab.paused", { tab_id: "tab_1" });
    expect(() => requireDesktopTab("u1", "r1", "tab_1")).toThrow(DesktopTabPausedError);

    handleDesktopTabNotification("u1", "tab.resumed", { tab_id: "tab_1" });
    expect(requireDesktopTab("u1", "r1", "tab_1").tabId).toBe("tab_1");
  });

  it("drops a tab the user closed", () => {
    registerDesktopTab("u1", "r1", "tab_1", AGENT_A);
    handleDesktopTabNotification("u1", "tab.closed", { tab_id: "tab_1" });
    expect(() => requireDesktopTab("u1", "r1", "tab_1")).toThrow(DesktopTabGoneError);
  });

  it("caps tabs per run and per user", () => {
    for (let i = 0; i < MAX_TABS_PER_RUN; i++) {
      assertTabBudget("u1", "r1");
      registerDesktopTab("u1", "r1", `tab_a${i}`, AGENT_A);
    }
    expect(() => assertTabBudget("u1", "r1")).toThrow(DesktopTabQuotaError);
    // Another run still has its own budget.
    expect(() => assertTabBudget("u1", "r2")).not.toThrow();

    let n = MAX_TABS_PER_RUN;
    while (n < MAX_TABS_PER_USER) {
      registerDesktopTab("u1", `r${n}`, `tab_b${n}`, AGENT_B);
      n++;
    }
    expect(() => assertTabBudget("u1", "r99")).toThrow(DesktopTabQuotaError);
  });

  it("releases every tab of a terminal run and leaves the others alone", () => {
    registerDesktopTab("u1", "r1", "tab_1", AGENT_A);
    registerDesktopTab("u1", "r1", "tab_2", AGENT_A);
    registerDesktopTab("u2", "r2", "tab_3", AGENT_B);

    const released = releaseDesktopLeaseByRun("r1");
    expect(released.map((r) => r.tabId).sort()).toEqual(["tab_1", "tab_2"]);
    expect(listDesktopTabsForRun("r1")).toHaveLength(0);
    expect(requireDesktopTab("u2", "r2", "tab_3").tabId).toBe("tab_3");
  });
});

describe("origin lease", () => {
  it("does not serialize runs living in different profiles", () => {
    registerDesktopTab("u1", "r1", "tab_1", AGENT_A);
    registerDesktopTab("u1", "r2", "tab_2", AGENT_B);

    acquireDesktopOriginLease(AGENT_A, "https://portal.example.com/login", "r1");
    // Same site, different agent profile: no shared cookie jar, no reason
    // to make the second run wait.
    expect(() =>
      acquireDesktopOriginLease(AGENT_B, "https://portal.example.com/login", "r2"),
    ).not.toThrow();
  });

  it("serializes two runs sharing a profile on the same origin", () => {
    acquireDesktopOriginLease(AGENT_A, "https://portal.example.com/login", "r1");
    expect(() =>
      acquireDesktopOriginLease(AGENT_A, "https://portal.example.com/other", "r2"),
    ).toThrow(DesktopLeaseConflictError);

    // A different site in the same profile is free.
    expect(() => acquireDesktopOriginLease(AGENT_A, "https://elsewhere.test/", "r2")).not.toThrow();
  });

  it("lets a run keep navigating inside the origin it holds", () => {
    acquireDesktopOriginLease(AGENT_A, "https://portal.example.com/a", "r1");
    expect(() =>
      acquireDesktopOriginLease(AGENT_A, "https://portal.example.com/b", "r1"),
    ).not.toThrow();
  });

  it("frees the origin when the holding run ends", () => {
    registerDesktopTab("u1", "r1", "tab_1", AGENT_A);
    acquireDesktopOriginLease(AGENT_A, "https://portal.example.com/", "r1");
    releaseDesktopLeaseByRun("r1");
    expect(() =>
      acquireDesktopOriginLease(AGENT_A, "https://portal.example.com/", "r2"),
    ).not.toThrow();
  });

  it("ignores targets that are not absolute URLs", () => {
    expect(() => acquireDesktopOriginLease(AGENT_A, "/relative/path", "r1")).not.toThrow();
  });

  it("keeps renewing the origin a working tab sits on", () => {
    registerDesktopTab("u1", "r1", "tab_1", AGENT_A);
    acquireDesktopOriginLease(AGENT_A, "https://portal.example.com/", "r1");
    noteDesktopTabOrigin("u1", "tab_1", "https://portal.example.com/deep/page");
    // Touching the tab must not hand the site to somebody else.
    requireDesktopTab("u1", "r1", "tab_1");
    expect(() => acquireDesktopOriginLease(AGENT_A, "https://portal.example.com/", "r2")).toThrow(
      DesktopLeaseConflictError,
    );
  });
});

describe("secret exposure boundary", () => {
  it("does not mix arbitrary evaluate and credential substitution in one run", () => {
    recordDesktopExposure(AGENT_A, "r1", "credential_substitution");
    expect(() => recordDesktopExposure(AGENT_A, "r1", "arbitrary_evaluate")).toThrow(
      DesktopExposureConflictError,
    );
  });

  it("does not let two runs split the pair across a shared profile", () => {
    // The v1 rule was per run, enforced implicitly by the global lease.
    // With concurrency, run B could otherwise evaluate scripts in the
    // very profile run A just typed a password into.
    recordDesktopExposure(AGENT_A, "r1", "credential_substitution");
    expect(() => recordDesktopExposure(AGENT_A, "r2", "arbitrary_evaluate")).toThrow(
      DesktopExposureConflictError,
    );
  });

  it("keeps separate profiles independent", () => {
    recordDesktopExposure(AGENT_A, "r1", "credential_substitution");
    expect(() => recordDesktopExposure(AGENT_B, "r2", "arbitrary_evaluate")).not.toThrow();
  });

  it("clears a run's exposure when it ends", () => {
    recordDesktopExposure(AGENT_A, "r1", "credential_substitution");
    releaseDesktopLeaseByRun("r1");
    expect(() => recordDesktopExposure(AGENT_A, "r2", "arbitrary_evaluate")).not.toThrow();
  });
});
