// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  groupModelsForPicker,
  type PickerConfig,
  type PickerCredential,
  type PickerModel,
} from "../src/components/model-picker-groups.ts";

const model = (over: Partial<PickerModel> & { id: string }): PickerModel => ({
  label: over.id,
  modelId: over.id,
  billed_to: "org",
  enabled: true,
  needs_reconnection: false,
  is_default: false,
  ...over,
});

const mistralConfig: PickerConfig = {
  id: "cfg_mistral",
  label: "Mistral",
  personal_connections_allowed: false,
  org_connection: "active",
};
const anthropicConfig: PickerConfig = {
  id: "cfg_anthropic",
  label: "Anthropic",
  personal_connections_allowed: true,
  org_connection: "none",
};
const myKey: PickerCredential = {
  id: "cred_me",
  label: "Ma clé perso",
  configId: "cfg_anthropic",
  subscription: false,
  needsReconnection: false,
  modelIds: ["claude-sonnet"],
};
const mySubscription: PickerCredential = {
  id: "cred_sub",
  label: "Mon Claude",
  configId: "cfg_anthropic",
  subscription: true,
  needsReconnection: false,
  modelIds: ["claude-sonnet"],
};

const mistral = model({
  id: "mistral-medium",
  config_id: "cfg_mistral",
  provider_name: "Mistral",
  is_default: true,
});
const claude = model({
  id: "claude-sonnet",
  config_id: "cfg_anthropic",
  billed_to: "user",
  provider_name: "Anthropic",
  providerId: "anthropic",
});
const claudeUnserved = { ...claude, billed_to: null as null };
const builtIn = model({ id: "sys-1", billed_to: "system", provider_name: "OpenAI" });
const configs = [mistralConfig, anthropicConfig];

describe("groupModelsForPicker", () => {
  it("groups by who pays, org first, then the person's own, then the system", () => {
    const groups = groupModelsForPicker([builtIn, claude, mistral], {
      credentials: [myKey],
      configs,
    });
    expect(groups.map((g) => [g.kind, g.name])).toEqual([
      ["org", "Mistral"],
      ["personal", "Ma clé perso"],
      ["system", null],
    ]);
  });

  it("names an org group after the provider until the configurations are known", () => {
    const [group] = groupModelsForPicker([mistral], { credentials: [] });
    expect(group).toMatchObject({ kind: "org", name: "Mistral" });
  });

  it("blocks no unserved model while the configurations load: no reason is definitive yet", () => {
    const [group] = groupModelsForPicker([claudeUnserved], { canConnect: true });
    expect(group).toMatchObject({ kind: "org", name: "Anthropic", needs: null });
    expect(group!.entries[0]!.blocked).toBeNull();
  });

  it("marks the default and leaves a usable model unblocked", () => {
    const [group] = groupModelsForPicker([mistral], { configs });
    expect(group!.entries).toEqual([{ model: mistral, isDefault: true, blocked: null }]);
  });

  it("prefers a subscription over a key for the same model, as the server does", () => {
    const [group] = groupModelsForPicker([claude], {
      credentials: [myKey, mySubscription],
      configs,
    });
    expect(group).toMatchObject({ name: "Mon Claude", subscription: true });
  });

  it("keeps a switched-off model, blocked as disabled", () => {
    const [group] = groupModelsForPicker([{ ...mistral, enabled: false }], { configs });
    expect(group!.entries[0]!.blocked).toBe("disabled");
  });

  it("blocks a model whose organization connection must be reconnected", () => {
    const [group] = groupModelsForPicker([{ ...mistral, billed_to: null }], {
      configs: [{ ...mistralConfig, org_connection: "needs_reconnection" }],
    });
    expect(group!.entries[0]!.blocked).toBe("orgUnavailable");
  });

  it("blocks a model whose configuration has no organization connection nor personal ones", () => {
    const [group] = groupModelsForPicker([{ ...mistral, billed_to: null }], {
      configs: [{ ...mistralConfig, org_connection: "none" }],
    });
    expect(group).toMatchObject({ kind: "org", name: "Mistral", needs: null });
    expect(group!.entries[0]!.blocked).toBe("orgConnectionMissing");
  });

  describe("a model of a configuration open to personal connections, none of the person's", () => {
    const context = { credentials: [], configs, canConnect: true };

    it("sits last, under its configuration, asking for a key with a link", () => {
      const groups = groupModelsForPicker([claudeUnserved, builtIn, mistral], context);
      const last = groups.at(-1)!;
      expect(last).toMatchObject({
        kind: "personal",
        name: "Anthropic",
        needs: { service: "Anthropic", fix: "add" },
      });
      expect(last.entries[0]!.blocked).toBe("personalRequired");
    });

    it("asks to reconnect when one of the person's keys of the configuration is dead", () => {
      const [group] = groupModelsForPicker([{ ...claudeUnserved, needs_reconnection: true }], {
        ...context,
        credentials: [{ ...myKey, needsReconnection: true }],
      });
      expect(group!.needs).toEqual({ service: "Anthropic", fix: "reconnect" });
      expect(group!.entries[0]!.blocked).toBe("personalReconnect");
    });

    it("asks to add a key when only the organization's connection is dead", () => {
      const [group] = groupModelsForPicker([{ ...claudeUnserved, needs_reconnection: true }], {
        ...context,
        configs: [{ ...anthropicConfig, org_connection: "needs_reconnection" }],
      });
      expect(group!.needs).toEqual({ service: "Anthropic", fix: "add" });
      expect(group!.entries[0]!.blocked).toBe("personalRequired");
    });

    it("ignores a dead key of another configuration", () => {
      const [group] = groupModelsForPicker([claudeUnserved], {
        ...context,
        credentials: [{ ...myKey, configId: "cfg_other", needsReconnection: true }],
      });
      expect(group!.needs?.fix).toBe("add");
    });

    it("offers no link to someone who may not add a key", () => {
      const [group] = groupModelsForPicker([claudeUnserved], { ...context, canConnect: false });
      expect(group!.needs?.fix).toBeNull();
    });

    it("keeps one group per configuration", () => {
      const groups = groupModelsForPicker(
        [claudeUnserved, { ...claudeUnserved, id: "claude-opus" }],
        context,
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]!.entries).toHaveLength(2);
    });
  });

  describe("in a schedule", () => {
    it("blocks a model only a personal connection serves, as without an organization connection", () => {
      const groups = groupModelsForPicker([claude, mistral, builtIn], {
        credentials: [myKey],
        configs,
        canConnect: true,
        scheduled: true,
      });
      const blocked = groups.flatMap((g) => g.entries).filter((e) => e.blocked);
      expect(blocked.map((e) => [e.model.id, e.blocked])).toEqual([
        ["claude-sonnet", "orgConnectionMissing"],
      ]);
    });

    it("serves through the organization connection a model the person pays for in person", () => {
      const [group] = groupModelsForPicker([claude], {
        credentials: [myKey],
        configs: [{ ...anthropicConfig, org_connection: "active" }],
        scheduled: true,
      });
      expect(group).toMatchObject({ kind: "org", name: "Anthropic" });
      expect(group!.entries[0]!.blocked).toBeNull();
    });

    it("offers no key to add: a key would not make the model schedulable", () => {
      const [group] = groupModelsForPicker([claudeUnserved], {
        credentials: [],
        configs,
        canConnect: true,
        scheduled: true,
      });
      expect(group!.needs).toBeNull();
      expect(group!.entries[0]!.blocked).toBe("orgConnectionMissing");
    });
  });

  it("groups a managed alias with no name", () => {
    const alias = model({ id: "alias", config_id: null, provider_name: null });
    const [group] = groupModelsForPicker([alias]);
    expect(group).toMatchObject({ kind: "org", name: null });
  });
});
