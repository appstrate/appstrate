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
  connectionsOfConfig,
  createConfigBody,
  defaultModelGroups,
  existingConfigFor,
  existingConfigIdOf,
  isSystemModel,
  keyUpdateBody,
  modelsOfConfig,
  onlySubscriptions,
  personalServing,
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

describe("connectChoices", () => {
  const config = modelConfigFixture();
  const registry = [ANTHROPIC, CLAUDE_CODE];

  it("offers the organization's first, then the caller's own, by kind of secret", () => {
    expect(
      connectChoices(config, registry, { org: true, personal: true }).map((c) => [
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
    expect(connectChoices(closed, registry, { org: false, personal: true })).toEqual([]);
  });

  it("skips a kind of secret the registry does not know", () => {
    expect(connectChoices(config, [ANTHROPIC], { org: true, personal: false })).toHaveLength(1);
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

  const groups = defaultModelGroups(
    [sonnet, off, mistral, groq, builtIn],
    [served, unserved, dead],
  );

  it("groups by configuration, named after it, the instance's last", () => {
    expect(groups.map((g) => [g.kind, g.name])).toEqual([
      ["config", "Anthropic"],
      ["config", "Mistral"],
      ["config", "Groq"],
      ["system", null],
    ]);
  });

  it("leaves out a switched-off model, marks the default", () => {
    expect(groups[0]!.entries).toEqual([{ model: sonnet, isDefault: true, blocked: null }]);
  });

  it("greys a model no live organization connection serves, with its reason", () => {
    expect(groups[1]!.entries[0]!.blocked).toBe("orgConnectionMissing");
    expect(groups[2]!.entries[0]!.blocked).toBe("orgUnavailable");
    expect(groups[3]!.entries[0]!.blocked).toBeNull();
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

  it("ignores the caller's connection of another configuration", () => {
    expect(personalServing(config, [{ ...mine, config_id: "cfg_2" }]).by).toBe("org");
  });
});
