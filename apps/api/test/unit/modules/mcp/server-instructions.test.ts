// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the MCP server `instructions` string: the connect bullet —
 * the only place an MCP client is told how to act on a readiness failure
 * (#1207) — and the agent-authoring guidance gated on `agents:write`.
 *
 * Prose is not the contract. Only the tokens a model branches on are pinned:
 * the STATUS it must recognize (409, never 400), the field it must read before
 * reaching for a tool (`connect_url`), the operation and the argument the
 * fallback kickoff must carry (`initiateIntegrationConnect` with `scopes` = the
 * item's `required_scopes`), the one thing that differs between the two client
 * kinds — delivery — and whether authoring guidance is present at all.
 */

import { describe, it, expect } from "bun:test";
import { OPERATION_INDEX_HEADING } from "@appstrate/core/chat-contract";
import {
  CONNECTION_RESOLUTION_WARNING_CODES,
  INSUFFICIENT_SCOPES_REMEDIES,
} from "@appstrate/core/integration";
import { RUN_AND_WAIT_RESUME_INSTRUCTION } from "@appstrate/core/run-and-wait-client";
import { RUN_AND_WAIT_LONG_POLL_RESUME } from "../../../../src/modules/mcp/tools.ts";
import { registerTestPlatformApp } from "../../../helpers/platform-app.ts";
import { instructionsFor, orgSpace, orgWideInstructionsFor } from "./helpers.ts";

// The appended operation index is filtered per operation against the mounted
// guards, so building the instructions reads the route table.
await registerTestPlatformApp();

/**
 * Launch and read back: the connect bullet is run-readiness guidance, so it is
 * only written for a caller who can get a run off the ground (`runAgent` and
 * `getRun` both granted);
 * its kickoff half also needs the grant `initiateIntegrationConnect` asks for.
 */
const permissions = new Set([
  "mcp:read",
  "mcp:invoke",
  "agents:run",
  "runs:read",
  "integrations:connect",
]);

/** The connect bullet only — asserting on the whole prompt would match the index. */
function connectBullet(rendersCards: boolean): string {
  const instructions = instructionsFor(permissions, rendersCards);
  const start = instructions.indexOf("- Connecting or reconnecting an integration before a run");
  const end = instructions.indexOf("\n- The exception —", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return instructions.slice(start, end);
}

describe("MCP server instructions — connect bullet", () => {
  it("names the readiness refusal as a 409 and never as a 400", () => {
    // The readiness envelope is `409 missing_integration_connection`
    // (services/agent-readiness.ts); a model told to expect a 400 treats the
    // 409 as an unknown failure and gives up instead of connecting.
    for (const rendersCards of [false, true]) {
      const bullet = connectBullet(rendersCards);
      expect(bullet).toMatch(/\b409 `missing_integration_connection`/);
      expect(bullet).not.toMatch(/\b400\b/);
    }
  });

  it("points at the item's own `connect_url` before the kickoff tool", () => {
    // An item that already carries a link is a finished offer; calling the
    // kickoff anyway mints a second capability and asks for consent twice.
    for (const rendersCards of [false, true]) {
      const bullet = connectBullet(rendersCards);
      expect(bullet).toMatch(/FIRST[^.]*`connect_url`/);
      expect(bullet.indexOf("connect_url")).toBeLessThan(
        bullet.indexOf("initiateIntegrationConnect"),
      );
    }
  });

  it("handles an inactive integration before any connect flow and asks before starting or widening a connection", () => {
    for (const rendersCards of [true, false]) {
      const bullet = connectBullet(rendersCards);
      const inactive = bullet.indexOf("On `integration_not_active`, offer activation and wait");
      const kickoff = bullet.indexOf('operation_id: "initiateIntegrationConnect"');
      expect(inactive).toBeGreaterThan(-1);
      expect(bullet.slice(inactive, kickoff)).toContain("Never start a connection for this code");
      expect(bullet.slice(inactive, kickoff)).toContain("Only after they choose it");
      expect(bullet).toContain("Only after the user chooses it, create it");
      expect(bullet).not.toContain("MUST start the connect flow yourself");
    }
  });

  it("binds the fallback kickoff's `scopes` to the item's `required_scopes`", () => {
    // Without the relay the consent re-grants the same insufficient set, and
    // `connection_id` is what keeps a reconnect on the existing row.
    const bullet = connectBullet(false);
    expect(bullet).toContain("initiateIntegrationConnect");
    expect(bullet).toMatch(/scopes: <[^>]*required_scopes/);
    expect(bullet).toMatch(
      /connection_id: <[^>]*connection_id, for an owned needs_reconnection item without a remedy only/,
    );
  });

  // #1871: an in-place upgrade widens every agent bound to the connection.
  it("answers `insufficient_scopes` with a new connection the run is rebound to", () => {
    for (const rendersCards of [false, true]) {
      const bullet = connectBullet(rendersCards);
      const start = bullet.indexOf("An `insufficient_scopes` item");
      expect(start).toBeGreaterThan(-1);
      const part = bullet.slice(start);
      expect(part).toContain("carries no `connect_url`");
      // Rebound by the launch override, which beats a member pin and works inline too.
      expect(part).toContain("`connection_overrides`");
      // …and the caller is told where the new connection's id comes from.
      expect(part).toMatch(/`listIntegrationConnections`|`candidate_connections` list the new one/);
      // The item's own `remedy` decides, every value named.
      for (const remedy of INSUFFICIENT_SCOPES_REMEDIES) {
        expect(part).toContain(`\`${remedy}\``);
      }
      // `connection_id` only on a reconnect.
      expect(bullet).toContain("for an owned needs_reconnection item without a remedy only");
    }
    const cannotConnect = instructionsFor(["mcp:read", "mcp:invoke", "agents:run", "runs:read"]);
    expect(cannotConnect).toContain("An `insufficient_scopes` item carries no `connect_url`");
    expect(cannotConnect).not.toContain("initiateIntegrationConnect");
  });

  it("names the member pin as the way to make a choice stick for a stored agent", () => {
    const exception = instructionsFor(permissions)
      .split("\n")
      .find((line) => line.startsWith("- The exception —"));
    expect(exception).toContain("`upsertMyIntegrationPin`");
  });

  it("differs between the two client kinds on delivery only", () => {
    // The chat renders the connect card from the tool result itself, so the
    // model restating the link duplicates it; an external client has no card,
    // so there the model must hand the URL over.
    const chat = connectBullet(true);
    const external = connectBullet(false);
    expect(chat).toContain("do NOT paste the link");
    expect(external).not.toContain("do NOT paste the link");
    expect(external).toMatch(/Give the caller that `connect_url`/);
    expect(chat).not.toMatch(/Give the caller that `connect_url`/);
    // Behaviour-shaping, not wording: dropping it turns a 409 into a poll loop.
    for (const bullet of [chat, external]) {
      expect(bullet).toMatch(/do NOT poll, loop, wait/);
      expect(bullet).toMatch(/authKey: "<the error's auth_key/);
    }
  });

  // #1830: only a `required` integration blocks the launch when nothing is
  // connected; an optional one lets the run start and comes back as a warning.
  it("tells a refused launch from a started run that lacks an integration", () => {
    const chat = connectBullet(true);
    const external = connectBullet(false);
    for (const bullet of [chat, external]) {
      expect(bullet).toMatch(/marks it `required`/);
      // Generated from the tuple, so a new warning code reaches the model.
      for (const code of CONNECTION_RESOLUTION_WARNING_CODES) {
        expect(bullet).toContain(`\`${code}\``);
      }
      // An explicit `[]` and an inactive integration warn too, without a connect target.
      expect(bullet).toMatch(/bound to none on purpose \(`\[\]`\), or inactive in the space/);
      expect(bullet).toMatch(/do not start a connect flow or re-run unless the caller asks/);
      // `null` = nothing judged (another member's schedule: their connections stay unrevealed).
      expect(bullet).toMatch(/A schedule write answers `warnings: null` when it judged nothing/);
      expect(bullet).toMatch(/written for another member, whose connections it never reveals/);
      expect(bullet).toMatch(/`\[\]` only when it judged and found nothing to report/);
    }
    // A started run's warning never carries a link from this server; the chat renders its own card.
    for (const bullet of [chat, external]) {
      expect(bullet).not.toMatch(/a `connect_url` only when the response carries one/);
      expect(bullet).not.toMatch(/from the warning's `connect_url`/);
    }
    expect(chat).toMatch(/the chat client renders a connect button under the run itself/);
    expect(chat).toMatch(/do NOT paste or promise a link/);
    expect(external).toMatch(/a warning here never carries a `connect_url`/);
    expect(external).toMatch(
      /start it with `initiateIntegrationConnect` from the warning's `auth_key` and `required_scopes`/,
    );
    expect(external).not.toMatch(/giving the caller the warning's `connect_url`/);
  });

  // #2336: a named connection is resolved from get_me and passed before launching.
  it("tells the model to resolve a named connection from get_me before launching", () => {
    const text = instructionsFor(permissions);
    expect(text).toContain("When the request names a connection");
    expect(text).toContain("each integration entry lists its `connections`");
    expect(text).toContain("BEFORE launching");
    expect(text).toContain("never launch without the integration the user asked for");
  });

  it("puts `active` on the integration entry, a configuration refusal to repair", () => {
    const text = instructionsFor(permissions);
    expect(text).toContain(
      "`active: false` on the entry means the integration is off in that space",
    );
    expect(text).not.toContain("is a connection the user holds");
    // The remedy and the space choice are the Org & space context's, not the connect bullet's.
    expect(text).not.toContain("never move it to another space");
    expect(text).not.toContain("direct them to the package in the organization catalog");
  });

  it("says a schedule write wants the user's one connection named too", () => {
    const bullet = instructionsFor(permissions)
      .split("\n")
      .find((line) => line.startsWith("- The exception — code `must_choose_connection`"));
    expect(bullet).toContain("An enabled schedule write answers this code for the user's one");
    expect(bullet).toContain("in the schedule's own `connection_overrides`");
  });

  it("names the layers a `required_integration_unbound` comes from and what clears it", () => {
    const bullet = instructionsFor(permissions)
      .split("\n")
      .find((line) => line.startsWith("- Code `required_integration_unbound`"));
    expect(bullet).toContain("a stored schedule's `connection_overrides`");
    expect(bullet).toContain("a run override outranks a member pin, not an admin pin");
  });
});

describe("MCP server instructions — named operations follow their grant", () => {
  const RUNNER = ["mcp:read", "mcp:invoke", "agents:run", "runs:read"];

  /** Prose only — the appended operation index would match on its own. */
  function prose(caller: readonly string[]): string {
    const instructions = instructionsFor(new Set(caller));
    return instructions.slice(0, instructions.indexOf(OPERATION_INDEX_HEADING));
  }

  it("leaves the connect kickoff out for a caller its route refuses", () => {
    // Ordered to call `initiateIntegrationConnect`, a caller without
    // `integrations:connect` would collect a 403 instead of a connect link.
    const cannotConnect = prose(RUNNER);
    expect(cannotConnect).not.toContain("initiateIntegrationConnect");
    // The control: the bullet is narrowed, not gone — the item's own link and
    // the ambiguity exception still apply to this caller.
    expect(cannotConnect).toContain("connect_url");
    expect(cannotConnect).toContain("must_choose_connection");
    expect(cannotConnect).not.toContain("When it does NOT");

    expect(prose([...RUNNER, "integrations:connect"])).toContain("initiateIntegrationConnect");
  });

  it("offers the integration listing only to a caller granted `listIntegrations`", () => {
    const withoutRead = prose(["mcp:read", "mcp:invoke"]);
    expect(withoutRead).not.toContain("listIntegrations");
    expect(withoutRead).not.toContain("GET /api/integrations");
    // The control: the pagination advice around the example stays.
    expect(withoutRead).toContain("query: { limit, startingAfter }");

    const withRead = prose(["mcp:read", "mcp:invoke", "integrations:read"]);
    expect(withRead).toContain("listIntegrations");
    expect(withRead).toContain("GET /api/integrations");
  });
});

describe("MCP server instructions — run guidance", () => {
  // Rule 1: an act the caller's set makes structurally impossible is ABSENT,
  // not contradicted. `run_and_wait` is declared on `McpSurface.runs`, so every
  // paragraph that teaches running goes with it — dropping that gate makes
  // each of these three markers reappear for the caller below.
  const RUNNER = new Set(["mcp:read", "mcp:invoke", "agents:run", "runs:read"]);
  const NO_RUN = new Set(["mcp:read", "mcp:invoke"]);

  /** Prose only — the appended operation index would match on its own. */
  function prose(caller: ReadonlySet<string>): string {
    const instructions = instructionsFor(caller, true);
    return instructions.slice(0, instructions.indexOf(OPERATION_INDEX_HEADING));
  }

  it("teaches run_and_wait, async runs and connect-before-run only to a caller who can run", () => {
    const withRuns = prose(RUNNER);
    const without = prose(NO_RUN);
    for (const marker of [
      "run_and_wait",
      "Runs are asynchronous",
      "Shortcut —",
      "Connecting or reconnecting an integration before a run",
      "must_choose_connection",
      "required_integration_unbound",
      // What a still-running run's result tells the model to do.
      "`done:false`",
    ]) {
      expect(withRuns).toContain(marker);
      expect(without).not.toContain(marker);
    }
  });

  it("follows a `done:false` run up by client: a long-poll outside the chat, a read inside it", () => {
    // The chat gets `done:false` at the end of its turn budget, with less time
    // left than a `wait: true` long-poll may block; an external client has time.
    const shortcutOf = (rendersCards: boolean) =>
      instructionsFor(RUNNER, rendersCards)
        .split("\n")
        .find((line) => line.startsWith("- Shortcut —"))!;
    const external = shortcutOf(false);
    expect(external).toContain(
      `\`done:false\` means its wait ended first. ${RUN_AND_WAIT_LONG_POLL_RESUME}`,
    );
    expect(external).not.toContain("with an `error`");
    const chat = shortcutOf(true);
    expect(chat).toContain(
      `\`done:false\` means its wait ended first. ${RUN_AND_WAIT_RESUME_INSTRUCTION}`,
    );
    expect(chat).not.toContain("wait: true");
    // The generic run bullet defers to the shortcut instead of contradicting it.
    for (const rendersCards of [false, true]) {
      expect(instructionsFor(RUNNER, rendersCards)).toContain(
        "for a run `run_and_wait` returned with `done:false`, see the shortcut below",
      );
    }
  });

  it("routes the agent's auth_key serving no selected tool to a configuration change", () => {
    const bulletOf = (caller: ReadonlySet<string>) =>
      prose(caller)
        .split("\n")
        .find((line) => line.startsWith("- Codes `auth_key_serves_no_selected_tool`"));
    const bullet = bulletOf(RUNNER);
    expect(bullet).toContain("configuration must change");
    expect(bullet).toContain("Do not start a connect flow");
    expect(bullet).toContain("Do not retry");
    // A caller that composes inline runs wrote the configuration itself.
    const composer = bulletOf(new Set([...RUNNER, "agents:write"]));
    expect(composer).toContain("in your manifest and retry");
    expect(composer).toContain("for a stored agent, do not retry");
  });

  // Same rule, applied inside a bullet rather than to a whole paragraph: an act
  // that needs `invoke_operation` is absent for a caller who was never declared
  // that tool, even when the bullet around it survives.
  // `integrations:read` on both: what separates them is the invoke tool alone.
  const READ_ONLY = new Set(["mcp:read", "integrations:read"]);
  const INVOKER = new Set(["mcp:read", "mcp:invoke", "integrations:read"]);

  it("withholds the invoke-only acts from a caller who can only read", () => {
    const readOnly = prose(READ_ONLY);
    // `query: { limit, startingAfter }` is `invoke_operation`'s argument envelope and
    // `GET /api/integrations` is an operation to call — neither is reachable.
    expect(readOnly).not.toContain("query: { limit, startingAfter }");
    expect(readOnly).not.toContain("GET /api/integrations");
    // The control: the bullets around them, and the section holding both, stay
    // — this is a targeted removal, not a collapsed prompt.
    expect(readOnly).toContain("Integration preference");
    expect(readOnly).toContain("## Beyond the per-operation schemas");
  });

  it("teaches both to a caller holding `mcp:invoke`", () => {
    const invoker = prose(INVOKER);
    expect(invoker).toContain("query: { limit, startingAfter }");
    expect(invoker).toContain("GET /api/integrations");
  });

  it("promises a conflict report only where importing is possible", () => {
    // The sentence tells the model what to do INSTEAD of importing; without the
    // tool there is no mutation to be talked out of.
    expect(instructionsFor(READ_ONLY, true)).not.toContain("non-importable");
    // Importing is `POST /api/packages/import-bundle`: any package `write`.
    expect(instructionsFor(INVOKER, true)).not.toContain("non-importable");
    expect(instructionsFor(new Set([...INVOKER, "skills:write"]), true)).toContain(
      "non-importable",
    );
    // The package-file bullet goes with its tools: absent for a caller who neither imports nor
    // composes, present for an importer.
    expect(prose(READ_ONLY)).not.toContain("validate_package_file");
    expect(prose(new Set([...INVOKER, "skills:write"]))).toContain(
      "Archive bytes stay server-side throughout.",
    );
  });

  it("keeps the integration-preference bullet for both — it stands on its own", () => {
    // The negative control for the case above: the run prose disappearing is a
    // targeted removal, not the whole "Beyond the per-operation schemas"
    // section going missing.
    expect(prose(RUNNER)).toContain("- Integration preference");
    expect(prose(NO_RUN)).toContain("- Integration preference");
  });
});

describe("MCP server instructions — agent authoring", () => {
  it("teaches tool selection and `dependencies.*` only to a caller holding `agents:write`", () => {
    const withWrite = instructionsFor(new Set(["mcp:read", "mcp:invoke", "agents:write"]), true);
    const without = instructionsFor(permissions, true);
    expect(withWrite).toContain("Integration tool selection");
    expect(withWrite).toContain("building or configuring an agent");
    expect(without).not.toContain("Integration tool selection");
    expect(without).not.toContain("building or configuring an agent");
  });

  // A default can hold write tools: an external client gets the narrowing rule from this text alone.
  it("tells an author to select the tools the agent needs rather than inherit the default", () => {
    const withWrite = instructionsFor(new Set(["mcp:read", "mcp:invoke", "agents:write"]), true);
    expect(withWrite).toContain(
      "List only the tools the agent needs; omit `tools` only when it needs the whole default",
    );
  });

  it("teaches `required` alongside the tool selection", () => {
    const withWrite = instructionsFor(new Set(["mcp:read", "mcp:invoke", "agents:write"]), true);
    expect(withWrite).toContain("`integrations_configuration[id].required`");
    expect(instructionsFor(permissions, true)).not.toContain(
      "`integrations_configuration[id].required`",
    );
  });

  it("withholds it from a caller who may author but not invoke", () => {
    // Authoring an agent is `createAgent` through `invoke_operation`: a
    // discovery-only caller cannot act on manifest guidance, so it is absent
    // rather than taught and then refused.
    const cannotInvoke = instructionsFor(new Set(["mcp:read", "agents:write"]), true);
    expect(cannotInvoke).not.toContain("Integration tool selection");
    expect(cannotInvoke).not.toContain("building or configuring an agent");
  });
});

describe("buildServerInstructions grounding", () => {
  it("points every client at get_me, the chat included: the tool is declared for all", () => {
    expect(instructionsFor(permissions, false)).toContain("Start by calling get_me");
    // The chat's own prompt states the caller and their role: get_me is for a space's
    // connections and agents.
    const chat = instructionsFor(permissions, true);
    expect(chat).not.toContain("Start by calling get_me");
    expect(chat).toContain("get_me lists a space's connected integrations");
  });
});

// ── The space hierarchy, written once (#2343) ──────────────────────────────
//
// Only the tokens a model branches on are pinned: the order, the personal space for an inline run
// and a new package, the three cases a space cannot serve and their remedies, and never switching
// silently. The chat layer states none of it (`prompt-invariants.test.ts`).

describe("MCP server instructions — org-wide space choice", () => {
  const AUTHOR = ["mcp:read", "mcp:invoke", "runs:read", "agents:run", "agents:write"];
  const OPERATOR = ["mcp:read", "mcp:invoke", "runs:read", "agents:run"];
  const mine = orgSpace("spc_mine", "Mine", "admin", true, AUTHOR);
  const team = orgSpace("spc_team", "Team", "builder", false, AUTHOR);
  const spaceContext = (text: string) =>
    text.slice(text.indexOf("## Org & space context"), text.indexOf("## Beyond the per-operation"));

  it("orders the choice: one listed, the request, personal, the context, a credential's own", () => {
    const text = spaceContext(orgWideInstructionsFor([mine, team]));
    const at = (fragment: string) => {
      const index = text.indexOf(fragment);
      expect(index).toBeGreaterThan(-1);
      return index;
    };
    const order = [
      "1. Only one space is listed",
      "2. The user's request names a space",
      "3. For an inline run",
      "4. For an act step 3 does not name",
      "5. A credential with no personal space",
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("the space the conversation was opened in");
    expect(text).toContain("`space_id`");
  });

  it("sends an inline run and a new package to the personal space where the role allows it", () => {
    const text = spaceContext(orgWideInstructionsFor([mine, team]));
    expect(text).toContain("an inline run (including a launch without waiting)");
    expect(text).toContain("a new package (agent, skill, integration)");
    expect(text).toContain("your personal space (the one marked `your personal space`)");
    expect(text).toContain("your reply names it");
  });

  it("names the personal space first even where the role is capped: the refusal there is what the model relays", () => {
    const capped = orgSpace("spc_mine", "Mine", "operator", true, OPERATOR);
    const text = spaceContext(orgWideInstructionsFor([capped, team]));
    // Same step as an uncapped caller: told in advance that the personal space refuses, a real
    // model picks the one space that allows and never asks.
    expect(text).toContain("3. For an inline run");
    expect(text).toContain("Send it there first, whatever your role there");
    expect(text).toContain("never a reason to start in another space");
    expect(text).toContain("403 `inline_run_not_allowed_in_space`");
  });

  it("uses the personal-space rule for runInline when no space grants the inline shortcut", () => {
    const capped = orgSpace("spc_mine", "Mine", "operator", true, OPERATOR);
    const team = orgSpace("spc_team", "Team", "custom", false, [
      "mcp:read",
      "mcp:invoke",
      "agents:write",
      "agents:run",
    ]);
    expect([capped, team].some((s) => s.surface.composes)).toBe(false);
    const instructions = orgWideInstructionsFor([capped, team]);
    expect(instructions).toContain("runInline [spc_team]");
    expect(spaceContext(instructions)).toContain("3. For an inline run");
    expect(spaceContext(instructions)).toContain(
      "ONLY spaces with launch permission are: spc_team.",
    );
    expect(instructions).toContain("`runAgent`/`runInline`");
    // No other space supplies the read half of run_and_wait on this connection.
    const launchOnly = orgWideInstructionsFor([team]);
    expect(launchOnly).toContain("To launch an inline run without waiting");
    expect(launchOnly).not.toContain("prefer the run_and_wait tool");
  });

  it("checks eligible teams before delivering an existing OAuth offer in chat and external MCP", () => {
    const operator = orgSpace("spc_default", "Default", "operator", false, OPERATOR);
    for (const cards of [true, false]) {
      const text = orgWideInstructionsFor([mine, team, operator], cards);
      const offer = text.slice(text.indexOf("When it HAS one"), text.indexOf("On a later turn"));
      expect(offer).toContain("do not start another connect flow");
      expect(offer).not.toContain("do NOT call any other tool");
      expect(offer).toContain(
        cards ? "do NOT paste the link" : "Give the caller that `connect_url`",
      );
      expect(text).toContain("with or without a `connect_url`");
      expect(text).toContain("team spaces with launch permission: spc_team.");
      expect(text).toContain("name that space alongside connecting one's own");
    }
  });

  it("offers direct calls in proxy-enabled teams even when they cannot launch an agent", () => {
    const proxy = orgSpace("spc_proxy", "Proxy", "custom", false, [
      "mcp:read",
      "mcp:invoke",
      "credential-proxy:call",
      "credential-proxy:call-own",
    ]);
    expect(proxy.surface.proxies).toBe(true);
    expect(proxy.surface.runs).toBe(false);
    expect(team.surface.proxies).toBe(false);
    const text = spaceContext(orgWideInstructionsFor([mine, proxy, team]));
    expect(text).toContain(
      "with `not_connected`, even with a link, search for its tool before replying",
    );
    expect(text).toContain("team spaces allowing `call_integration_tool`: spc_proxy.");
    expect(text).toContain("ONLY spaces with launch permission are: spc_mine, spc_team.");
    expect(text).not.toContain("Options, both to state: running in a named team space");
    const withoutProxy = spaceContext(orgWideInstructionsFor([mine, team]));
    expect(withoutProxy).not.toContain("team spaces allowing `call_integration_tool`");
  });

  it("names the personal space for a new package to a caller who may create a skill but no agent", () => {
    // The destination follows the right to create ANY package type: decided on `createAgent`
    // alone, a skill author's "create a skill" fell to the conversation's team space.
    const skillAuthor = [...OPERATOR, "skills:write"];
    const text = spaceContext(
      orgWideInstructionsFor([
        orgSpace("spc_mine", "Mine", "operator", true, OPERATOR),
        orgSpace("spc_team", "Team", "custom", false, skillAuthor),
      ]),
    );
    expect(text).toContain("a new package (agent, skill, integration)");
    expect(text).toContain("your personal space (the one marked `your personal space`)");
  });

  it("has no personal-space step for a caller with no personal space", () => {
    const text = spaceContext(orgWideInstructionsFor([team]));
    expect(text).toContain("You have no personal space");
    expect(text).not.toContain("your personal space (the one marked");
  });

  it("names the three cases a space cannot serve, each with its remedy", () => {
    const text = spaceContext(orgWideInstructionsFor([mine, team]));
    expect(text).toContain("STOP: make no further call that changes anything or acts elsewhere");
    expect(text).toContain("only the user's answer in a later message chooses one");
    expect(text).toContain("Naming an integration in the request is not that answer");
    // (a) off there: activate, or offer to the organization; a space's own row still wins.
    expect(text).toContain("(a) The integration is off there");
    expect(text).toContain("`activatePackage`");
    expect(text).toContain("`offerPackageToOrg`");
    expect(text).toContain("from chat, the organization catalog");
    expect(text).toContain("a space's own switched-off row still wins");
    expect(text).toContain("no connection becomes reachable by it");
    // (b) the connection is not reachable there: connect one's own, or a team space.
    expect(text).toContain("(b) The connection needed is missing or not reachable there");
    expect(text).toContain("never reaches a personal space");
    expect(text).toContain("Options, both to state: using it in a named team space");
    expect(text).toContain("connecting one's own");
    expect(text).toContain("Offer another space only when your role there allows the act");
    expect(text).toContain("Never suggest sharing a member's account");
    // (c) the role does not allow it: a named space of the refusal, with the user's choice.
    expect(text).toContain("(c) Your role there does not allow the act");
    expect(text).toContain("`not_granted`");
    expect(text).toContain("`inline_run_not_allowed_in_space`");
    expect(text).toContain("`granted_in`");
    expect(text).toContain("act there only once the user chooses it");
    // An existing agent: a space where it is active.
    expect(text).toContain("use a space where it is active");
    expect(text).toContain("`active_in_spaces`");
  });

  it("states the permission refusal once, as proposing a space, not as final", () => {
    const text = spaceContext(orgWideInstructionsFor([mine, team]));
    expect(text).not.toContain("is final for that task");
    expect(text.match(/Do not retry in another space on your own/g)).toHaveLength(1);
  });

  it("tells the model to pass `space_id` to `search` whenever the space is known", () => {
    const text = spaceContext(orgWideInstructionsFor([mine, team]));
    expect(text).toContain("pass that `space_id` to `search` too");
    expect(text).toContain("search every space only when the space is unknown");
    expect(text).toContain("An empty result is the answer");
    expect(text).toContain("only the spaces that supplied entries shown");
    expect(text).toContain("`searched_spaces`");
    expect(text).toContain("`granted_in`");
  });

  it("keeps the personal-space carve-out for keys, end-users and OIDC clients", () => {
    const text = spaceContext(orgWideInstructionsFor([mine, team]));
    for (const code of [
      "personal_space_takes_no_keys",
      "personal_space_takes_no_end_users",
      "personal_space_takes_no_oauth_clients",
    ]) {
      expect(text).toContain(code);
    }
  });

  it("gives a pinned connection no choice order, with the permission/configuration split in one sentence", () => {
    const text = spaceContext(instructionsFor(permissions));
    expect(text).toContain("the one space this connection is pinned to");
    expect(text).toContain("A refusal for your role (`403`, `not_granted`) is final");
    expect(text).toContain("A configuration refusal");
    expect(text).not.toContain("Choose the space in this order");
    expect(text).not.toContain("never move it");
    expect(text).not.toContain("from chat");
    expect(text).not.toContain("offerPackageToOrg");
  });

  it("states no space rule outside the Org & space context", () => {
    const text = orgWideInstructionsFor([mine, team], true);
    const outside = text.replace(spaceContext(text), "");
    for (const restated of ["your personal space", "the space your context designates"]) {
      expect(outside).not.toContain(restated);
    }
  });
});
