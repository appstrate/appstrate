// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  groupModelsForPicker,
  type PickerCredential,
  type PickerModel,
} from "../src/components/model-picker-groups.ts";

const model = (over: Partial<PickerModel> & { id: string }): PickerModel => ({
  label: over.id,
  modelId: over.id,
  binding: "org",
  billed_to: "org",
  enabled: true,
  needs_reconnection: false,
  is_default: false,
  ...over,
});

const orgKey: PickerCredential = {
  id: "cred_org",
  label: "Mistral (Alice)",
  owner: "org",
  subscription: false,
  modelIds: [],
};
const myKey: PickerCredential = {
  id: "cred_me",
  label: "Ma clé perso",
  owner: "me",
  subscription: false,
  modelIds: ["claude-sonnet"],
};
const mySubscription: PickerCredential = {
  id: "cred_sub",
  label: "Mon Claude",
  owner: "me",
  subscription: true,
  modelIds: ["claude-sonnet"],
};

const mistral = model({
  id: "mistral-medium",
  credentialId: "cred_org",
  provider_name: "Mistral",
  is_default: true,
});
const claude = model({
  id: "claude-sonnet",
  binding: "member",
  credentialId: null,
  billed_to: "user",
  provider_name: "Anthropic",
  providerId: "anthropic",
});
const claudeUnserved = { ...claude, billed_to: null as null };
const builtIn = model({ id: "sys-1", billed_to: "system", provider_name: "OpenAI" });

describe("groupModelsForPicker", () => {
  it("groups by who pays, org first, then the person's own, then the system", () => {
    const groups = groupModelsForPicker([builtIn, claude, mistral], {
      credentials: [orgKey, myKey],
    });
    expect(groups.map((g) => [g.kind, g.name])).toEqual([
      ["org", "Mistral (Alice)"],
      ["personal", "Ma clé perso"],
      ["system", null],
    ]);
  });

  it("names an org group after the provider when the person cannot read the credential", () => {
    const [group] = groupModelsForPicker([mistral], { credentials: [] });
    expect(group).toMatchObject({ kind: "org", name: "Mistral" });
  });

  it("marks the default and leaves a usable model unblocked", () => {
    const [group] = groupModelsForPicker([mistral], { credentials: [orgKey] });
    expect(group!.entries).toEqual([{ model: mistral, isDefault: true, blocked: null }]);
  });

  it("prefers a subscription over a key for the same model, as the server does", () => {
    const [group] = groupModelsForPicker([claude], { credentials: [myKey, mySubscription] });
    expect(group).toMatchObject({ name: "Mon Claude", subscription: true });
  });

  it("keeps a switched-off model, blocked as disabled", () => {
    const [group] = groupModelsForPicker([{ ...mistral, enabled: false }], {
      credentials: [orgKey],
    });
    expect(group!.entries[0]!.blocked).toBe("disabled");
  });

  it("keeps a model whose org credential is unavailable, blocked", () => {
    const [group] = groupModelsForPicker([{ ...mistral, needs_reconnection: true }], {
      credentials: [orgKey],
    });
    expect(group!.entries[0]!.blocked).toBe("orgUnavailable");
  });

  describe("a personal model with no credential of the person's", () => {
    const context = { credentials: [], personalAllowed: true, canConnect: true };

    it("sits last, under its service, asking for a key with a link", () => {
      const groups = groupModelsForPicker([claudeUnserved, builtIn, mistral], context);
      const last = groups.at(-1)!;
      expect(last).toMatchObject({
        kind: "personal",
        name: "Anthropic",
        needs: { service: "Anthropic", fix: "add" },
      });
      expect(last.entries[0]!.blocked).toBe("personalRequired");
    });

    it("asks to reconnect when one of the person's keys is dead", () => {
      const [group] = groupModelsForPicker(
        [{ ...claudeUnserved, needs_reconnection: true }],
        context,
      );
      expect(group!.needs).toEqual({ service: "Anthropic", fix: "reconnect" });
      expect(group!.entries[0]!.blocked).toBe("personalReconnect");
    });

    it("offers no link when the organization turned personal keys off", () => {
      const [group] = groupModelsForPicker([claudeUnserved], {
        ...context,
        personalAllowed: false,
      });
      expect(group!.needs).toEqual({ service: "Anthropic", fix: null });
      expect(group!.entries[0]!.blocked).toBe("personalOff");
    });

    it("offers no link to someone who may not add a key", () => {
      const [group] = groupModelsForPicker([claudeUnserved], { ...context, canConnect: false });
      expect(group!.needs?.fix).toBeNull();
    });

    it("keeps one group per service", () => {
      const groups = groupModelsForPicker(
        [claudeUnserved, { ...claudeUnserved, id: "claude-opus" }],
        context,
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]!.entries).toHaveLength(2);
    });
  });

  describe("in a schedule", () => {
    it("blocks every model a personal credential serves, whoever pays", () => {
      const groups = groupModelsForPicker([claude, claudeUnserved, mistral, builtIn], {
        credentials: [orgKey, myKey],
        personalAllowed: true,
        canConnect: true,
        scheduled: true,
      });
      const blocked = groups.flatMap((g) => g.entries).filter((e) => e.blocked);
      expect(blocked.map((e) => e.blocked)).toEqual(["notSchedulable", "notSchedulable"]);
    });

    it("offers no key to add: a key would not make the model schedulable", () => {
      const [group] = groupModelsForPicker([claudeUnserved], {
        credentials: [],
        personalAllowed: true,
        canConnect: true,
        scheduled: true,
      });
      expect(group!.needs?.fix).toBeNull();
    });

    it("leaves org and system models usable", () => {
      const groups = groupModelsForPicker([mistral, builtIn], {
        credentials: [orgKey],
        scheduled: true,
      });
      expect(groups.flatMap((g) => g.entries).every((e) => e.blocked === null)).toBe(true);
    });
  });

  it("groups a managed alias with no name", () => {
    const alias = model({
      id: "alias",
      binding: "managed",
      credentialId: null,
      provider_name: null,
    });
    const [group] = groupModelsForPicker([alias]);
    expect(group).toMatchObject({ kind: "org", name: null });
  });
});
