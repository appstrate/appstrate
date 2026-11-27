// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseDismissedTips, sidebarTips, type SidebarTipFacts } from "../sidebar-tips";

/** A new organization's first visit by its owner: nothing done, everything allowed. */
const fresh: SidebarTipFacts = {
  connections: 0,
  conversations: 0,
  agents: 0,
  schedules: 0,
  people: 1,
  canConnect: true,
  canCreateWithChat: true,
  canInvite: true,
  canSchedule: true,
  canBrowseCatalogue: true,
};

const tips = (facts: Partial<SidebarTipFacts>, dismissed: string[] = [], here = ["/"]) =>
  sidebarTips({ ...fresh, ...facts }, dismissed, here);

describe("sidebarTips", () => {
  it("lists a new organization's steps in the order it meets them, the catalogue last", () => {
    // No agent yet: there is nothing to schedule.
    expect(tips({})).toEqual(["connect", "chat", "invite", "catalogue"]);
  });

  it("drops each step once it is done", () => {
    expect(tips({ connections: 2, conversations: 1, agents: 1, schedules: 1, people: 3 })).toEqual([
      "catalogue",
    ]);
  });

  it("offers the chat until the person's first conversation, whatever agents the space holds", () => {
    expect(tips({ agents: 1, conversations: 0 })).toContain("chat");
    expect(tips({ conversations: 1 })).not.toContain("chat");
  });

  it("offers scheduling once an agent exists and none is scheduled", () => {
    expect(tips({ agents: 1, schedules: 0 })).toContain("schedule");
    expect(tips({ agents: 1, schedules: 2 })).not.toContain("schedule");
  });

  it("counts a pending invitation as a colleague already on the way", () => {
    expect(tips({ people: 2 })).not.toContain("invite");
  });

  it("draws no card while its data is being read", () => {
    expect(
      tips({
        connections: undefined,
        conversations: undefined,
        agents: undefined,
        schedules: undefined,
        people: undefined,
      }),
    ).toEqual(["catalogue"]);
  });

  it("draws no card the caller's role cannot act on", () => {
    expect(
      tips({
        canConnect: false,
        canCreateWithChat: false,
        canInvite: false,
        canSchedule: false,
        canBrowseCatalogue: false,
        agents: 1,
      }),
    ).toEqual([]);
  });

  it("keeps a dismissed card away", () => {
    expect(tips({}, ["connect", "catalogue"])).toEqual(["chat", "invite"]);
  });

  it("hides the card of the page on screen, an overlay included", () => {
    expect(tips({}, [], ["/integrations"])).not.toContain("connect");
    expect(tips({}, [], ["/integrations/@acme/gmail"])).not.toContain("connect");
    expect(tips({}, [], ["/", "/catalogue/skill"])).not.toContain("catalogue");
    expect(tips({}, [], ["/", "/org-settings/members"])).not.toContain("invite");
  });
});

describe("parseDismissedTips", () => {
  it("keeps only card ids", () => {
    expect(parseDismissedTips(["chat", "nope", 3, "connect"])).toEqual(["connect", "chat"]);
    expect(parseDismissedTips({ chat: true })).toEqual([]);
    expect(parseDismissedTips(null)).toEqual([]);
  });
});
