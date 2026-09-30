// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseVersionZipKey, versionZipKey } from "../../../src/services/package-storage-keys.ts";
import {
  packageItemKey,
  packageItemKeyId,
  SYSTEM_STORAGE_NAMESPACE,
} from "../../../src/services/package-items/config.ts";

describe("package storage key parsers invert their builders", () => {
  it.each([
    ["@acme/skill", "1.0.0"],
    ["@acme/skill", "2.0.0-beta.3+build.7"],
    ["@a-b/c-d", "0.0.1"],
  ])("versionZipKey(%s, %s)", (packageId, version) => {
    expect(parseVersionZipKey(versionZipKey(packageId, version))).toEqual({ packageId, version });
  });

  it.each([
    ["org_123", "skills", "@acme/skill"],
    [SYSTEM_STORAGE_NAMESPACE, "mcp-servers", "@appstrate/server"],
    ["2f0c1c1e-9a4e-4d3b-a1b6-0e7c3a2b1d00", "agents", "@acme/agent"],
  ] as const)("packageItemKey(%s, %s, %s)", (ns, folder, id) => {
    expect(packageItemKeyId(packageItemKey(folder, ns, id))).toBe(id);
  });

  it.each(["", "/1.0.0.afps", "@acme/skill/1.0.0", "@acme/skill/.afps", "noslash.afps"])(
    "parseVersionZipKey rejects %p",
    (key) => {
      expect(parseVersionZipKey(key)).toBeNull();
    },
  );

  it.each([
    "",
    "org/skills",
    "org/skills/@acme/skill.zip",
    "org//@acme/skill.afps",
    "org/skills/.afps",
  ])("packageItemKeyId rejects %p", (key) => {
    expect(packageItemKeyId(key)).toBeNull();
  });
});
