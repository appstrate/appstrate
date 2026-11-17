// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { orgTile, spaceTile } from "../identity-tile-props.ts";

describe("orgTile", () => {
  it("draws an organization by its own icon and colour, seeded by its id", () => {
    expect(orgTile({ id: "org_1", name: "Tractr", icon: "emoji:🚜", color: null })).toEqual({
      icon: "emoji:🚜",
      color: null,
      seed: "org_1",
      label: "Tractr",
    });
  });
});

describe("spaceTile", () => {
  const viewer = { id: "usr_me", name: "Ada Lovelace" };
  const space = { id: "spc_1", name: "Studio", icon: "lucide:rocket", color: "violet" };

  it("draws a team space by its own icon and colour", () => {
    expect(spaceTile({ ...space, personal: false }, viewer)).toEqual({
      icon: "lucide:rocket",
      color: "violet",
      seed: "spc_1",
      label: "Studio",
    });
  });

  it("draws the viewer's own personal space as the viewer", () => {
    expect(
      spaceTile({ ...space, icon: null, color: null, personal: true, orphaned_at: null }, viewer),
    ).toEqual({ icon: null, color: null, seed: "usr_me", label: "Ada Lovelace" });
  });

  it("draws the own personal space as an unnamed person while no session is known", () => {
    expect(
      spaceTile({ ...space, icon: null, color: null, personal: true, orphaned_at: null }, null),
    ).toEqual({ icon: "lucide:user", color: null, seed: "spc_1", label: "Studio" });
  });

  it("draws an orphaned personal space as a person who is gone, never as the viewer", () => {
    expect(
      spaceTile(
        { ...space, icon: null, color: null, personal: true, orphaned_at: "2026-10-01T00:00:00Z" },
        viewer,
      ),
    ).toEqual({ icon: "lucide:user-x", color: null, seed: "spc_1", label: "Studio" });
  });
});
