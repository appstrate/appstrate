// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { availableReauthMethods } from "../reauth-methods";

const ALL_ON = { googleAuth: true, githubAuth: true };

describe("availableReauthMethods", () => {
  it("credential only → password", () => {
    expect(availableReauthMethods([{ providerId: "credential" }], ALL_ON)).toEqual([
      { kind: "password" },
    ]);
  });

  it("credential + google → password first, then google", () => {
    expect(
      availableReauthMethods([{ providerId: "credential" }, { providerId: "google" }], ALL_ON),
    ).toEqual([{ kind: "password" }, { kind: "social", provider: "google" }]);
  });

  it("google only → google social", () => {
    expect(availableReauthMethods([{ providerId: "google" }], ALL_ON)).toEqual([
      { kind: "social", provider: "google" },
    ]);
  });

  it("google linked but feature off → []", () => {
    expect(
      availableReauthMethods([{ providerId: "google" }], { googleAuth: false, githubAuth: true }),
    ).toEqual([]);
  });

  it("github + google → google before github, both social", () => {
    expect(
      availableReauthMethods([{ providerId: "github" }, { providerId: "google" }], ALL_ON),
    ).toEqual([
      { kind: "social", provider: "google" },
      { kind: "social", provider: "github" },
    ]);
  });

  it("undefined accounts → []", () => {
    expect(availableReauthMethods(undefined, ALL_ON)).toEqual([]);
  });

  it("empty accounts → []", () => {
    expect(availableReauthMethods([], ALL_ON)).toEqual([]);
  });

  it("unknown providers are ignored", () => {
    expect(
      availableReauthMethods([{ providerId: "twitter" }, { providerId: "credential" }], ALL_ON),
    ).toEqual([{ kind: "password" }]);
  });

  it("ordering: password always first even when accounts list it last", () => {
    const methods = availableReauthMethods(
      [{ providerId: "google" }, { providerId: "github" }, { providerId: "credential" }],
      ALL_ON,
    );
    expect(methods[0]).toEqual({ kind: "password" });
    expect(methods).toEqual([
      { kind: "password" },
      { kind: "social", provider: "google" },
      { kind: "social", provider: "github" },
    ]);
  });

  it("github linked but only google feature on → []", () => {
    expect(
      availableReauthMethods([{ providerId: "github" }], { googleAuth: true, githubAuth: false }),
    ).toEqual([]);
  });
});
