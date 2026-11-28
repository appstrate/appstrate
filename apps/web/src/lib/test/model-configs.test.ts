// SPDX-License-Identifier: Apache-2.0

/**
 * Model configurations read off the wire, and every body the models pages send: pinned here
 * because the typed client checks shapes, not values.
 */

import { describe, expect, it } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials.ts";
import { orgModelFixture as model } from "../../test/org-model-fixture.ts";
import { connectionFixture, modelConfigFixture } from "../../test/model-config-fixtures.ts";
import {
  configState,
  configUpdateBody,
  connectChoices,
  connectionBody,
  connectionLabelBody,
  connectionTestBody,
  connectionsOfConfig,
  createConfigBody,
  defaultModelGroups,
  existingConfigFor,
  existingConfigIdOf,
  isSystemModel,
  keyUpdateBody,
  modelsOfConfig,
  onlySubscriptions,
  orgConnectionSummary,
  personalServing,
  preferencesConfigs,
  repairableConnections,
  seedModelsBody,
  systemModels,
} from "../model-configs.ts";

const entry = (over: Partial<ProviderRegistryEntry>) =>
  ({
    providerId: "anthropic",
    displayName: "Anthropic",
    authMode: "api_key",
    baseUrlOverridable: false,
    ...over,
  }) as ProviderRegistryEntry;
const ANTHROPIC = entry({});
const CLAUDE_CODE = entry({
  providerId: "claude-code",
  displayName: "Claude Code",
  authMode: "oauth2",
});
const GATEWAY = entry({ providerId: "openai-compatible", baseUrlOverridable: true });

describe("the models of a configuration", () => {
  const own = model({ id: "m1", config_id: "cfg_1" });
  const off = model({ id: "m2", config_id: "cfg_1", enabled: false });
  const other = model({ id: "m3", config_id: "cfg_2" });
  const builtIn = model({ id: "s1", config_id: null, source: "built-in" });
  const alias = model({ id: "a1", config_id: null, aliased: true });

  it("keeps its own, switched-off ones included", () => {
    expect(modelsOfConfig([own, off, other, builtIn], "cfg_1").map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("leaves built-in models and managed aliases to the instance", () => {
    expect(isSystemModel(builtIn)).toBe(true);
    expect(isSystemModel(alias)).toBe(true);
    expect(systemModels([own, builtIn, alias]).map((m) => m.id)).toEqual(["s1", "a1"]);
  });
});

describe("configState", () => {
  it("is active with a live organization connection", () => {
    expect(configState(modelConfigFixture())).toBe("active");
  });

  it("asks to reconnect when the organization's connections are dead", () => {
    expect(configState(modelConfigFixture({ org_connection: "needs_reconnection" }))).toBe(
      "reconnect",
    );
  });

  it("is active when only members serve it, and to connect when nobody does", () => {
    const personal = modelConfigFixture({ org_connection: "none", personal_connection_count: 2 });
    expect(configState(personal)).toBe("active");
    expect(configState({ ...personal, personal_connection_count: 0 })).toBe("connect");
    expect(configState({ ...personal, personal_connections_allowed: false })).toBe("connect");
    expect(configState({ ...personal, personal_connection_count: null })).toBe("connect");
  });
});

describe("the connections of a configuration", () => {
  const org = connectionFixture();
  const sub = connectionFixture({ id: "c2", authMode: "oauth2" });
  const member = connectionFixture({ id: "c3", owner_type: "user", owner_id: "u1" });
  const elsewhere = connectionFixture({ id: "c4", config_id: "cfg_2" });

  it("splits the organization's from members'", () => {
    const split = connectionsOfConfig([org, sub, member, elsewhere], "cfg_1");
    expect(split.org.map((c) => c.id)).toEqual(["cred_org", "c2"]);
    expect(split.personal.map((c) => c.id)).toEqual(["c3"]);
  });

  it("warns when the organization connects only subscriptions", () => {
    expect(onlySubscriptions([sub])).toBe(true);
    expect(onlySubscriptions([sub, org])).toBe(false);
    expect(onlySubscriptions([])).toBe(false);
  });
});

describe("orgConnectionSummary", () => {
  it("counts the organization's connections the caller reads", () => {
    expect(orgConnectionSummary("active", 2)).toEqual({
      key: "modelConfigs.summary.orgConnections",
      count: 2,
    });
    expect(orgConnectionSummary("needs_reconnection", 1)).toEqual({
      key: "modelConfigs.summary.orgConnections",
      count: 1,
    });
  });

  it("says the state alone when the caller cannot read them", () => {
    expect(orgConnectionSummary("active", null)).toEqual({
      key: "modelConfigs.summary.orgConnection",
    });
    expect(orgConnectionSummary("active", 0)).toEqual({
      key: "modelConfigs.summary.orgConnection",
    });
  });

  it("says there is none, whatever the count", () => {
    expect(orgConnectionSummary("none", null)).toEqual({
      key: "modelConfigs.summary.noOrgConnection",
    });
    expect(orgConnectionSummary("none", 0)).toEqual({
      key: "modelConfigs.summary.noOrgConnection",
    });
  });
});

describe("connectChoices", () => {
  const config = modelConfigFixture();
  const registry = [ANTHROPIC, CLAUDE_CODE];

  it("offers the organization's first, then the caller's own, by kind of secret", () => {
    expect(
      connectChoices(config, registry, { org: true, personal: true }, []).map((c) => [
        c.owner,
        c.provider.providerId,
      ]),
    ).toEqual([
      ["org", "anthropic"],
      ["org", "claude-code"],
      ["user", "anthropic"],
      ["user", "claude-code"],
    ]);
  });

  it("offers no personal connection where the configuration refuses them", () => {
    const closed = { ...config, personal_connections_allowed: false };
    expect(connectChoices(closed, registry, { org: false, personal: true }, [])).toEqual([]);
  });

  it("offers no personal connection where the caller already has one in the configuration", () => {
    const owners = (own: { config_id: string }[]) =>
      connectChoices(config, registry, { org: true, personal: true }, own).map((c) => c.owner);
    expect(owners([{ config_id: config.id }])).not.toContain("user");
    expect(owners([{ config_id: "cfg_other" }])).toContain("user");
  });

  it("skips a kind of secret the registry does not know", () => {
    expect(connectChoices(config, [ANTHROPIC], { org: true, personal: false }, [])).toHaveLength(1);
  });
});

describe("existingConfigFor", () => {
  const configs = [modelConfigFixture()];

  it("finds the family's configuration, by its provider or a provider it accepts", () => {
    expect(existingConfigFor(configs, ANTHROPIC)?.id).toBe("cfg_1");
    expect(existingConfigFor(configs, CLAUDE_CODE)?.id).toBe("cfg_1");
  });

  it("never stands in for a gateway, which has one configuration per endpoint", () => {
    expect(existingConfigFor(configs, GATEWAY)).toBeUndefined();
  });
});

describe("existingConfigIdOf", () => {
  it("reads the configuration a 409 points at", () => {
    const err = new ApiError("model_config_exists", "exists", 409, undefined, {
      existing_config_id: "cfg_1",
    });
    expect(existingConfigIdOf(err)).toBe("cfg_1");
  });

  it("is null for any other failure", () => {
    expect(existingConfigIdOf(new ApiError("forbidden", "no", 403))).toBeNull();
    expect(existingConfigIdOf(new Error("boom"))).toBeNull();
  });
});

describe("the request bodies", () => {
  it("creates a catalog configuration with no endpoint, and its label only when typed", () => {
    expect(
      createConfigBody({
        provider: ANTHROPIC,
        label: "  ",
        baseUrl: "https://ignored",
        personalConnectionsAllowed: false,
      }),
    ).toEqual({ provider_id: "anthropic", personal_connections_allowed: false });
  });

  it("creates a gateway with its endpoint and its label, trimmed", () => {
    expect(
      createConfigBody({
        provider: GATEWAY,
        label: " Ollama ",
        baseUrl: " http://localhost:11434 ",
        personalConnectionsAllowed: true,
      }),
    ).toEqual({
      provider_id: "openai-compatible",
      label: "Ollama",
      base_url: "http://localhost:11434",
      personal_connections_allowed: true,
    });
  });

  it("changes one field of a configuration at a time", () => {
    expect(configUpdateBody({ baseUrl: " http://h " })).toEqual({ base_url: "http://h" });
    expect(configUpdateBody({ label: " Équipe " })).toEqual({ label: "Équipe" });
    expect(configUpdateBody({ personalConnectionsAllowed: false })).toEqual({
      personal_connections_allowed: false,
    });
  });

  it("connects an API key to its configuration, owned as asked", () => {
    expect(
      connectionBody({
        providerId: "anthropic",
        configId: "cfg_1",
        apiKey: " sk-test ",
        ownerType: "user",
      }),
    ).toEqual({
      providerId: "anthropic",
      api_key: "sk-test",
      config_id: "cfg_1",
      owner_type: "user",
    });
  });

  it("changes a key alone", () => {
    expect(keyUpdateBody(" sk-new ")).toEqual({ api_key: "sk-new" });
  });

  it("seeds the onboarding's models into the configuration", () => {
    expect(seedModelsBody("cfg_1", ["a", "b"])).toEqual({
      config_id: "cfg_1",
      model_ids: ["a", "b"],
    });
  });
});

describe("defaultModelGroups", () => {
  const served = modelConfigFixture();
  const unserved = modelConfigFixture({ id: "cfg_2", label: "Mistral", org_connection: "none" });
  const dead = modelConfigFixture({
    id: "cfg_3",
    label: "Groq",
    org_connection: "needs_reconnection",
  });
  const sonnet = model({ id: "m1", config_id: "cfg_1", is_default: true });
  const off = model({ id: "m2", config_id: "cfg_1", enabled: false });
  const mistral = model({ id: "m3", config_id: "cfg_2" });
  const groq = model({ id: "m4", config_id: "cfg_3" });
  const builtIn = model({ id: "s1", config_id: null, source: "built-in" });
  const orgKey = connectionFixture({ serves_model_ids: ["m1", "m2"] });
  const configs = [served, unserved, dead];
  const groups = defaultModelGroups([sonnet, off, mistral, groq, builtIn], configs, [orgKey]);

  it("groups as the other pickers do: by configuration name, the instance's last", () => {
    expect(groups.map((g) => [g.kind, g.name])).toEqual([
      ["org", "Anthropic"],
      ["org", "Groq"],
      ["org", "Mistral"],
      ["system", null],
    ]);
  });

  it("leaves out a switched-off model, marks the default", () => {
    expect(groups[0]!.entries).toEqual([
      { model: { ...sonnet, billed_to: "org" }, isDefault: true, blocked: null },
    ]);
  });

  it("keeps a switched-off model that is the current default, greyed", () => {
    const [group] = defaultModelGroups([{ ...off, is_default: true }], configs, [orgKey]);
    expect(group!.entries[0]!.blocked).toBe("disabled");
  });

  it("greys a model no live organization connection serves, with its reason", () => {
    const reasons = Object.fromEntries(
      groups.flatMap((g) => g.entries).map((e) => [e.model.id, e.blocked]),
    );
    expect(reasons).toMatchObject({
      m1: null,
      m3: "orgConnectionMissing",
      m4: "orgUnavailable",
      s1: null,
    });
  });

  it("decides per model: a connection serving other models does not make this one eligible", () => {
    const sibling = model({ id: "m5", config_id: "cfg_1" });
    const [group] = defaultModelGroups([sonnet, sibling], [served], [orgKey]);
    expect(group!.entries.map((e) => [e.model.id, e.blocked])).toEqual([
      ["m1", null],
      ["m5", "orgConnectionMissing"],
    ]);
  });

  it("falls back on the configuration's state when the connections cannot be read", () => {
    const result = defaultModelGroups([sonnet, mistral, groq], configs, undefined);
    const reasons = Object.fromEntries(
      result.flatMap((g) => g.entries).map((e) => [e.model.id, e.blocked]),
    );
    expect(reasons).toEqual({ m1: null, m3: "orgConnectionMissing", m4: "orgUnavailable" });
  });

  it("ignores a dead organization connection and the members' own", () => {
    const own = connectionFixture({
      id: "c_me",
      owner_type: "user",
      owner_id: "u1",
      serves_model_ids: ["m1"],
    });
    const deadKey = { ...orgKey, needs_reconnection: true };
    const [group] = defaultModelGroups([sonnet], [served], [own, deadKey]);
    expect(group!.entries[0]!.blocked).toBe("orgConnectionMissing");
  });
});

describe("personalServing", () => {
  const config = modelConfigFixture();
  const mine = connectionFixture({ id: "c_me", owner_type: "user", owner_id: "u1" });

  it("names the caller's own live connection first", () => {
    expect(personalServing(config, [mine])).toEqual({
      by: "mine",
      connection: mine,
      state: "active",
    });
  });

  it("asks to reconnect the caller's dead connection", () => {
    const dead = { ...mine, needs_reconnection: true };
    expect(personalServing(config, [dead])).toMatchObject({ by: "mine", state: "reconnect" });
  });

  it("falls back on the organization's connection, then on nobody", () => {
    expect(personalServing(config, [])).toEqual({ by: "org", state: "active" });
    expect(personalServing({ ...config, org_connection: "none" }, [])).toEqual({
      by: "none",
      state: "connect",
    });
  });

  it("prefers a live subscription over a key, as the server does", () => {
    const key = { ...mine, id: "c_key" };
    const subscription = { ...mine, id: "c_sub", authMode: "oauth2" as const };
    const result = personalServing(config, [key, subscription]);
    expect(result).toMatchObject({ by: "mine", connection: { id: "c_sub" } });
  });

  it("ignores the caller's connection of another configuration", () => {
    expect(personalServing(config, [{ ...mine, config_id: "cfg_2" }]).by).toBe("org");
  });
});

describe("repairableConnections", () => {
  const dead = connectionFixture({ id: "dead", needs_reconnection: true });
  const deadSub = connectionFixture({
    id: "dead_sub",
    authMode: "oauth2",
    needs_reconnection: true,
    allowed_actions: ["reconnect", "delete"],
  });
  const live = connectionFixture({ id: "live" });
  const deadNoRight = connectionFixture({
    id: "dead_ro",
    needs_reconnection: true,
    allowed_actions: [],
  });

  it("keeps the dead connections the caller may repair, by the action their kind needs", () => {
    expect(repairableConnections([dead, deadSub, live, deadNoRight]).map((c) => c.id)).toEqual([
      "dead",
      "dead_sub",
    ]);
  });

  it("does not take « edit » for a subscription's repair", () => {
    const sub = { ...deadSub, allowed_actions: ["edit" as const] };
    expect(repairableConnections([sub])).toEqual([]);
  });
});

describe("preferencesConfigs", () => {
  const open = modelConfigFixture({ id: "cfg_open" });
  const closed = modelConfigFixture({ id: "cfg_closed", personal_connections_allowed: false });
  const closedWithMine = modelConfigFixture({
    id: "cfg_closed_mine",
    personal_connections_allowed: false,
  });
  const mine = connectionFixture({ config_id: "cfg_closed_mine", owner_type: "user" });

  it("lists the open configurations, and the closed ones where the caller keeps a connection", () => {
    expect(preferencesConfigs([open, closed, closedWithMine], [mine]).map((c) => c.id)).toEqual([
      "cfg_open",
      "cfg_closed_mine",
    ]);
  });
});

describe("connectionLabelBody", () => {
  it("sends the label alone, trimmed", () => {
    expect(connectionLabelBody("  Ma clé  ")).toEqual({ label: "Ma clé" });
  });
});

describe("connectionTestBody", () => {
  it("tries the typed key against the configuration, trimmed", () => {
    expect(
      connectionTestBody({
        providerId: "openai-compatible",
        configId: "cfg_1",
        apiKey: "  sk-test ",
        credentialId: null,
      }),
    ).toEqual({ providerId: "openai-compatible", config_id: "cfg_1", api_key: "sk-test" });
  });

  it("names the stored connection, with no key, when none is typed", () => {
    expect(
      connectionTestBody({
        providerId: "anthropic",
        configId: "cfg_1",
        apiKey: "   ",
        credentialId: "cred_1",
      }),
    ).toEqual({ providerId: "anthropic", config_id: "cfg_1", credentialId: "cred_1" });
  });
});
