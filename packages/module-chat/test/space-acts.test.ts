// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces a turn can act in, as the context block names them: a line each while they fit,
 * grouped by identical acts when they do not, counted when even that does not fit; every space at
 * the same level, none cut.
 */

import { describe, expect, it } from "bun:test";
import {
  CHAT_CONTEXT_SPACES_BUDGET_CHARS,
  SPACES_HEADING,
  describeSpaceActs,
  formatSpaces,
  type ContextSpace,
} from "../src/space-acts.ts";

describe("describeSpaceActs", () => {
  it("follows the space's line with what the turn may do there", () => {
    expect(
      describeSpaceActs({
        id: "spc_p",
        name: "Perso",
        role: "admin",
        personal: true,
        can: ["invoke_operations", "inline_runs"],
      }),
    ).toBe(
      "Perso (`spc_p`, role admin, your personal space) — can: invoke_operations, inline_runs",
    );
  });

  it("says a space allowing no act is for looking things up only", () => {
    expect(describeSpaceActs({ id: "spc_v", name: "Lecture", role: "viewer", can: [] })).toBe(
      "Lecture (`spc_v`, role viewer) — can: nothing but looking things up",
    );
  });
});

describe("formatSpaces", () => {
  const space = (i: number, can: ContextSpace["can"]): ContextSpace => ({
    id: `spc_${String(i).padStart(4, "0")}`,
    name: `Equipe ${String(i).padStart(4, "0")}`,
    role: "operator",
    can,
  });

  it("is empty without a space", () => {
    expect(formatSpaces([])).toBe("");
  });

  it("gives a line per space, in the order given, while they fit", () => {
    const text = formatSpaces([space(2, ["run_agents"]), space(1, [])]);
    expect(text.split("\n")).toEqual([
      SPACES_HEADING,
      "- Equipe 0002 (`spc_0002`, role operator) — can: run_agents",
      "- Equipe 0001 (`spc_0001`, role operator) — can: nothing but looking things up",
    ]);
  });

  it("groups the spaces by identical acts, every space named, when the lines do not fit", () => {
    const spaces = Array.from({ length: 60 }, (_, i) =>
      space(i, i % 2 === 0 ? ["run_agents"] : ["run_agents", "inline_runs"]),
    );
    const per = [SPACES_HEADING, ...spaces.map((s) => `- ${describeSpaceActs(s)}`)].join("\n");
    expect(per.length).toBeGreaterThan(CHAT_CONTEXT_SPACES_BUDGET_CHARS);
    const text = formatSpaces([...spaces].reverse());
    expect(text.length).toBeLessThanOrEqual(CHAT_CONTEXT_SPACES_BUDGET_CHARS);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]!.startsWith("- can: run_agents — Equipe 0000 (`spc_0000`")).toBe(true);
    expect(lines[2]!.startsWith("- can: run_agents, inline_runs — Equipe 0001")).toBe(true);
    for (const s of spaces) expect(text).toContain(`\`${s.id}\``);
    // Whatever order the spaces came in, the same text: the system prompt's cache holds.
    expect(formatSpaces(spaces)).toBe(text);
  });

  it("only counts them, and points to get_me, when even the groups do not fit", () => {
    const spaces = Array.from({ length: 300 }, (_, i) => space(i, ["run_agents"]));
    const text = formatSpaces(spaces);
    expect(formatSpaces(spaces, 100_000).length).toBeGreaterThan(CHAT_CONTEXT_SPACES_BUDGET_CHARS);
    expect(text.split("\n")).toEqual([
      SPACES_HEADING,
      "300 spaces, not listed here for room: `get_me` lists them with their `can`.",
    ]);
  });
});
